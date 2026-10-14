const { WhatsAppBot } = require("./bot");
const { logger, SESSION, DISABLE_START_MESSAGE } = require('../config');
const { sequelize } = require("./database");
const { CustomAuthState } = require("./auth");
const { flushQueueOnShutdown, stopFlushTimer } = require("./store");

function notifyAccountOnStartup(bot, sessionId) {
    if (DISABLE_START_MESSAGE) {
        return;
    }

    let notificationSent = false;
    const sendNotifications = async () => {
        if (notificationSent) {
            return;
        }
        notificationSent = true;

        const accountJid = bot.sock?.user?.id?.replace(/:\d+(?=@)/, "");
        if (!accountJid) {
            logger.error({ session: sessionId }, "Cannot send startup messages: linked account JID is unavailable.");
            return;
        }

        await bot.sock.sendMessage(accountJid, { text: "Thunder MAX has started." });
        await bot.sock.sendMessage(accountJid, { text: `Session ID: ${sessionId}` });
        logger.info({ session: sessionId }, "Sent startup and session ID messages to the linked account.");
    };

    const handleConnectionUpdate = ({ connection }) => {
        if (connection === "open") {
            sendNotifications().catch((error) => {
                logger.error({ session: sessionId, err: error }, "Failed to send startup messages to the linked account.");
            });
        }
    };

    bot.sock.ev.on("connection.update", handleConnectionUpdate);
    if (bot.isConnected) {
        handleConnectionUpdate({ connection: "open" });
    }
}

class BotManager {
    constructor() {
        this.bots = new Map(); 
    }

    async startSession(sessionId, { method = "qr", phoneNumber, onUpdate } = {}) {
        if (this.bots.has(sessionId)) {
            throw new Error("This session is already running.");
        }

        const bot = new WhatsAppBot(sessionId);
        let initializationError;
        const initialization = bot.initialize().catch((error) => {
            initializationError = error;
        });
        const socketDeadline = Date.now() + 30000;

        while (!bot.sock && !initializationError && Date.now() < socketDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        if (!bot.sock) {
            await initialization;
            throw initializationError || new Error("Timed out waiting for the WhatsApp connection to initialize.");
        }

        const publishUpdate = (update) => {
            try {
                onUpdate?.(update);
            } catch (error) {
                logger.error({ session: sessionId, err: error }, "Failed to publish pairing status.");
            }
        };

        bot.sock.ev.on("connection.update", (update) => {
            if (update.qr) {
                publishUpdate({ status: "waiting_for_scan", qr: update.qr });
            }
            if (update.connection === "open") {
                publishUpdate({ status: "connected", qr: null, pairingCode: null });
            }
        });
        bot.sock.ev.on("creds.update", (creds) => {
            if (creds.registered) {
                publishUpdate({ status: "connected", qr: null, pairingCode: null });
            }
        });

        this.bots.set(sessionId, bot);

        try {
            await initialization;
            if (initializationError) {
                throw initializationError;
            }

            let pairingCode;
            if (method === "code") {
                if (bot.sock.authState?.creds?.registered) {
                    throw new Error("This session is already linked.");
                }
                if (typeof bot.sock.requestPairingCode !== "function") {
                    throw new Error("This Baileys socket does not support pairing codes.");
                }
                pairingCode = await bot.sock.requestPairingCode(phoneNumber);
                publishUpdate({ status: "waiting_for_code", pairingCode, qr: null });
            }

            notifyAccountOnStartup(bot, sessionId);
            return { bot, pairingCode };
        } catch (error) {
            this.bots.delete(sessionId);
            await bot.disconnect(false).catch((disconnectError) => {
                logger.error({ session: sessionId, err: disconnectError }, "Failed to close an unsuccessful pairing connection.");
            });
            throw error;
        }
    }

    async removeSession(sessionId) {
        const bot = this.bots.get(sessionId);
        if (bot) {
            await bot.disconnect(false);
            this.bots.delete(sessionId);
        }
        await CustomAuthState.deleteSessionById(sessionId);
        const sessionIndex = SESSION.indexOf(sessionId);
        if (sessionIndex !== -1) {
            SESSION.splice(sessionIndex, 1);
        }
    }

    async initializeBots(pairingOptions) {
        logger.info({ sessions: SESSION }, `Initializing all configured bots.`);
        await CustomAuthState.deleteGarbageSessions(SESSION);        
        for (const sessionId of SESSION) {
            try {
                logger.info({ session: sessionId }, `Attempting to initialize bot for session.`);
                const bot = new WhatsAppBot(sessionId);
                await bot.initialize(); 
                if (bot.sock) { 
                    notifyAccountOnStartup(bot, sessionId);
                    if (pairingOptions?.method === "code" && sessionId === pairingOptions.sessionId) {
                        if (typeof bot.sock.requestPairingCode !== "function") {
                            throw new Error("This Baileys socket does not support pairing codes.");
                        }
                        if (bot.sock.authState?.creds?.registered) {
                            throw new Error("This session is already linked. Remove SESSION and start again to pair a new account.");
                        }
                        const code = await bot.sock.requestPairingCode(pairingOptions.phoneNumber);
                        console.log(`\nWhatsApp pairing code: ${code}\n`);
                    }
                    this.bots.set(sessionId, bot);
                    logger.info({ session: sessionId }, `Bot initialization scheduled. Connection status will follow.`);
                } else {
                    logger.error({ session: sessionId }, `Bot object for session could not be initialized (sock is null).`);
                    if (pairingOptions?.sessionId === sessionId) {
                        throw new Error("The WhatsApp connection could not be initialized for pairing.");
                    }
                }
            } catch (error) {
                console.error(`Failed to initialize session ${sessionId}: ${error.message}`);
                logger.error({ session: sessionId, err: error }, `Overall failure to initialize bot in BotManager`);
                if (pairingOptions?.sessionId === sessionId) {
                    throw error;
                }
            }
        }
    }

    getBot(sessionId) {
        return this.bots.get(sessionId);
    }

    async sendMessage(sessionId, jid, message) {
        const bot = this.getBot(sessionId);
        if (!bot) {
            throw new Error(`No bot found or initialized for session: ${sessionId}`);
        }
        return await bot.sendMessage(jid, message);
    }

    async shutdown() {
        logger.info('Shutting down all bots...');

    try {
      stopFlushTimer();
      await flushQueueOnShutdown();
    } catch (err) {
      logger.error({ err }, "Failed to flush message queue during shutdown");
    }

    try {
      logger.info("Saving all session data before shutdown...");
      await CustomAuthState.saveAllSessions();
      logger.info("All session data saved successfully");
    } catch (error) {
      logger.error({ err: error }, "Error saving sessions during shutdown");
    }

        for (const [sessionId, bot] of this.bots.entries()) {
            try {
                await bot.disconnect(false); 
                logger.info({ session: sessionId }, `Bot disconnected successfully.`);
            } catch (error) {
                logger.error({ session: sessionId, err: error }, `Error during bot disconnection.`);
            }
        }
        this.bots.clear(); 

        try {
            CustomAuthState.stopPeriodicSave();
            logger.info('Auth periodic save timer stopped');
        } catch (error) {
            logger.error({ err: error }, 'Error stopping periodic save timer');
        }

        try {
            const Schedule = require('./schedulers');
            await Schedule.cleanup();
            logger.info('Scheduled tasks cleaned up');
        } catch (error) {
            logger.error({ err: error }, 'Error cleaning up scheduled tasks');
        }

        if (sequelize) {
            try {
                await sequelize.close();
                logger.info('Database connection closed.');
            } catch (error) {
                logger.error({ err: error }, 'Error closing database connection.');
            }
        }
    }
}

module.exports = { BotManager, notifyAccountOnStartup };
