const { randomBytes } = require("crypto");
const config = require("../config");
const { CustomAuthState } = require("./auth");
const { BotVariable, WhatsappSession } = require("./database");
const { initializeTerminalAuthState } = require("./terminal-pairing");

const editableSettings = {
  BOT_NAME: "text",
  HANDLERS: "text",
  SUDO: "text",
  MODE: "mode",
  LANGUAGE: "text",
  ALIVE: "text",
  DISABLE_START_MESSAGE: "boolean",
  READ_MESSAGES: "boolean",
  READ_COMMAND: "boolean",
  ALWAYS_ONLINE: "boolean",
  REJECT_CALLS: "boolean",
  ADMIN_ACCESS: "boolean",
  MULTI_HANDLERS: "boolean",
};

const pairingStates = new Map();

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function allowedOrigins() {
  return (process.env.PORTAL_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (!allowedOrigins().includes(origin)) {
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "600");
  return true;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function requireAdmin(request) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const adminEmail = process.env.DASHBOARD_ADMIN_EMAIL?.trim().toLowerCase();
  if (!supabaseUrl || !anonKey || !adminEmail) {
    const error = new Error(
      "The dashboard API is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and DASHBOARD_ADMIN_EMAIL on the bot host."
    );
    error.statusCode = 503;
    throw error;
  }

  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!token) {
    const error = new Error("Sign in to the dashboard to continue.");
    error.statusCode = 401;
    throw error;
  }

  let authResponse;
  try {
    authResponse = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    const error = new Error("Could not verify the dashboard sign-in with Supabase.");
    error.statusCode = 503;
    throw error;
  }
  if (!authResponse.ok) {
    const error = new Error("Your dashboard sign-in has expired. Please sign in again.");
    error.statusCode = 401;
    throw error;
  }

  const user = await authResponse.json();
  if (typeof user.email !== "string" || user.email.toLowerCase() !== adminEmail) {
    const error = new Error("This account is not authorized to manage Thunder MAX.");
    error.statusCode = 403;
    throw error;
  }
}

async function prunePairingStates(botManager) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, state] of pairingStates) {
    if (state.updatedAt >= cutoff) {
      continue;
    }
    if (["starting", "waiting_for_scan", "waiting_for_code"].includes(state.status)) {
      await botManager.removeSession(id);
    }
    if (state.updatedAt < cutoff) {
      pairingStates.delete(id);
    }
  }
}

async function listSessions(botManager) {
  const rows = await WhatsappSession.findAll({
    attributes: ["sessionId"],
    order: [["createdAt", "ASC"]],
  });
  return rows.map(({ sessionId }) => {
    const bot = botManager.getBot(sessionId);
    const pairing = pairingStates.get(sessionId);
    return {
      sessionId,
      status: bot?.isConnected
        ? "connected"
        : pairing?.status || (bot ? "connecting" : "saved"),
    };
  });
}

async function readSettings() {
  const keys = Object.keys(editableSettings);
  const rows = await BotVariable.findAll({ where: { key: keys } });
  const saved = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  return Object.fromEntries(keys.map((key) => [key, saved[key] ?? config[key]]));
}

function normalizeSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("Settings must be sent as a JSON object."), { statusCode: 400 });
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const type = editableSettings[key];
    if (!type) {
      throw Object.assign(new Error(`Setting '${key}' cannot be changed from the dashboard.`), { statusCode: 400 });
    }
    if (type === "boolean") {
      if (typeof value !== "boolean") {
        throw Object.assign(new Error(`${key} must be true or false.`), { statusCode: 400 });
      }
      result[key] = value;
      continue;
    }
    if (typeof value !== "string" || value.length > 2000) {
      throw Object.assign(new Error(`${key} must be text no longer than 2000 characters.`), { statusCode: 400 });
    }
    const normalized = value.trim();
    if (type === "mode" && !["private", "public"].includes(normalized)) {
      throw Object.assign(new Error("MODE must be 'private' or 'public'."), { statusCode: 400 });
    }
    result[key] = normalized;
  }
  return result;
}

async function handleApiRequest(request, response, botManager) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    return false;
  }

  if (!applyCors(request, response)) {
    sendJson(response, 403, { error: "This website origin is not allowed by the bot host." });
    return true;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }

  try {
    await requireAdmin(request);
    const route = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && route === "/api/portal/sessions") {
      sendJson(response, 200, { sessions: await listSessions(botManager) });
      return true;
    }

    if (request.method === "GET" && route === "/api/portal/settings") {
      sendJson(response, 200, { settings: await readSettings() });
      return true;
    }

    if (request.method === "PUT" && route === "/api/portal/settings") {
      const values = normalizeSettings(await readJson(request));
      for (const [key, value] of Object.entries(values)) {
        await BotVariable.upsert({ key, value: String(value) });
      }
      sendJson(response, 200, {
        settings: await readSettings(),
        restartRequired: Object.keys(values).length > 0,
      });
      return true;
    }

    if (request.method === "POST" && route === "/api/portal/pairings") {
      await prunePairingStates(botManager);
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input) || !["qr", "code"].includes(input.method)) {
        throw Object.assign(new Error("Choose either QR or pairing-code setup."), { statusCode: 400 });
      }
      let phoneNumber;
      if (input.method === "code") {
        if (typeof input.phoneNumber !== "string" || !/^[+\d\s().-]+$/.test(input.phoneNumber)) {
          throw Object.assign(new Error("Enter a valid phone number with country code."), { statusCode: 400 });
        }
        phoneNumber = input.phoneNumber.replace(/\D/g, "");
        if (!/^\d{8,15}$/.test(phoneNumber)) {
          throw Object.assign(new Error("Phone number must contain 8 to 15 digits, including country code."), { statusCode: 400 });
        }
      }
      const pendingCount = Array.from(pairingStates.values()).filter(
        ({ status }) => ["starting", "waiting_for_scan", "waiting_for_code"].includes(status)
      ).length;
      if (pendingCount >= 5) {
        throw Object.assign(new Error("There are already five unfinished pairing attempts. Finish or remove one before starting another."), { statusCode: 429 });
      }

      const sessionId = randomBytes(9).toString("hex");
      const state = {
        sessionId,
        method: input.method,
        status: "starting",
        qr: null,
        pairingCode: null,
        error: null,
        updatedAt: Date.now(),
      };
      pairingStates.set(sessionId, state);
      try {
        await initializeTerminalAuthState(sessionId);
      } catch (error) {
        Object.assign(state, { status: "failed", error: error.message, updatedAt: Date.now() });
        try {
          await CustomAuthState.deleteSessionById(sessionId);
        } catch (cleanupError) {
          config.logger.error({ session: sessionId, err: cleanupError }, "Failed to remove incomplete pairing credentials.");
        }
        throw error;
      }
      config.SESSION.push(sessionId);
      botManager.startSession(sessionId, {
        method: input.method,
        phoneNumber,
        onUpdate: (update) => {
          Object.assign(state, update, { updatedAt: Date.now() });
        },
      }).then(async ({ pairingCode }) => {
        if (!pairingStates.has(sessionId)) {
          await botManager.removeSession(sessionId);
          return;
        }
        if (pairingCode) {
          Object.assign(state, { pairingCode, status: "waiting_for_code", updatedAt: Date.now() });
        }
      }).catch(async (error) => {
        Object.assign(state, { status: "failed", error: error.message, updatedAt: Date.now() });
        const sessionIndex = config.SESSION.indexOf(sessionId);
        if (sessionIndex !== -1) config.SESSION.splice(sessionIndex, 1);
        try {
          await CustomAuthState.deleteSessionById(sessionId);
        } catch (cleanupError) {
          config.logger.error({ session: sessionId, err: cleanupError }, "Failed to remove incomplete pairing credentials.");
        }
      });
      sendJson(response, 202, {
        sessionId,
        status: state.status,
        pairingCode: state.pairingCode,
      });
      return true;
    }

    const pairingMatch = route.match(/^\/api\/portal\/pairings\/([a-f0-9]{18})$/);
    if (request.method === "GET" && pairingMatch) {
      const state = pairingStates.get(pairingMatch[1]);
      if (!state) {
        sendJson(response, 404, { error: "Pairing attempt not found. Start a new pairing." });
      } else {
        sendJson(response, 200, {
          sessionId: state.sessionId,
          method: state.method,
          status: state.status,
          qr: state.qr,
          pairingCode: state.pairingCode,
          error: state.error,
        });
      }
      return true;
    }

    const sessionMatch = route.match(/^\/api\/portal\/sessions\/([a-f0-9]{18})$/);
    if (request.method === "DELETE" && sessionMatch) {
      const sessionId = sessionMatch[1];
      if (process.env.SESSION?.split(",").some((entry) => entry.split("~").pop().trim() === sessionId)) {
        throw Object.assign(new Error("Remove this session from the host's SESSION environment variable before deleting it here."), { statusCode: 409 });
      }
      await botManager.removeSession(sessionId);
      pairingStates.delete(sessionId);
      sendJson(response, 200, { deleted: true });
      return true;
    }

    sendJson(response, 404, { error: "Dashboard API route not found." });
  } catch (error) {
    config.logger.error({ err: error, path: url.pathname }, "Dashboard API request failed.");
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : "Dashboard request failed. Check the bot host logs for details.",
    });
  }
  return true;
}

module.exports = { handleApiRequest };
