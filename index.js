const path = require("path");
const fs = require("fs");
if (fs.existsSync("./config.env")) {
  require("dotenv").config({ path: "./config.env" });
} else {
  require("dotenv").config();
}

const { suppressLibsignalLogs } = require("./core/helpers");

suppressLibsignalLogs();

const { initializeDatabase, WhatsappSession, BotVariable } = require("./core/database");
const { BotManager } = require("./core/manager");
const { handleApiRequest } = require("./core/portal-api");
const {
  promptTerminalPairing,
  initializeTerminalAuthState,
} = require("./core/terminal-pairing");
const config = require("./config");
const { SESSION, logger } = config;
const http = require("http");
const {
  ensureTempDir,
  TEMP_DIR,
  initializeKickBot,
  cleanupKickBot,
} = require("./core/helpers");

async function main() {
  ensureTempDir();
  logger.info(`Created temporary directory at ${TEMP_DIR}`);
  console.log(`Thunder MAX v${require("./package.json").version} - developed by Decan`);
  let pairingOptions;
  try {
    await initializeDatabase();
    const savedSessions = await WhatsappSession.findAll({
      attributes: ["sessionId"],
    });
    for (const { sessionId } of savedSessions) {
      if (!SESSION.includes(sessionId)) {
        SESSION.push(sessionId);
      }
    }
    const savedVariables = await BotVariable.findAll();
    config.loadFromDB(
      Object.fromEntries(savedVariables.map(({ key, value }) => [key, value]))
    );
    console.log("- Database initialized");
    logger.info("Database initialized successfully.");
  } catch (dbError) {
    console.error(
      "🚫 Failed to initialize database or load configuration. Bot cannot start.",
      dbError
    );
    logger.fatal(
      "🚫 Failed to initialize database or load configuration. Bot cannot start.",
      dbError
    );
    process.exit(1);
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    pairingOptions = await promptTerminalPairing(SESSION.length > 0);
    if (pairingOptions) {
      SESSION.push(pairingOptions.sessionId);
    }
  }
  console.log(`- Configured sessions: ${SESSION.join(", ")}`);
  logger.info(`Configured sessions: ${SESSION.join(", ")}`);

  if (pairingOptions) {
    await initializeTerminalAuthState(pairingOptions.sessionId);
  }

  const botManager = new BotManager();

  const shutdownHandler = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    logger.info(`Received ${signal}, shutting down...`);
    cleanupKickBot();
    await botManager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdownHandler("SIGINT"));
  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));

  await botManager.initializeBots(pairingOptions);
  if (pairingOptions) {
    console.log(
      `\nIf linking succeeds, save this in your .env file:\nSESSION=${SESSION.map((id) => `RGNK~${id}`).join(",")}\n`
    );
  }
  console.log("- Bot initialization complete.");
  logger.info("Bot initialization complete");

  initializeKickBot();

  const startServer = () => {
    const PORT = process.env.PORT || 3000;

    const server = http.createServer(async (req, res) => {
      if (await handleApiRequest(req, res, botManager)) {
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Thunder MAX is running!");
      }
    });

    server.listen(PORT, () => {
      logger.info(`Web server listening on port ${PORT}`);
    });
  };

  if (process.env.USE_SERVER !== "false") startServer();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error in main execution: ${error.message}`, error);
    logger.fatal({ err: error }, `Fatal error in main execution`);
    process.exit(1);
  });
}
