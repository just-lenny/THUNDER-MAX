const { randomBytes } = require("crypto");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { CustomAuthState } = require("./auth");

async function promptTerminalPairing(hasConfiguredSessions = false) {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log("Welcome to Thunder MAX. Developed by Decan.");
    if (hasConfiguredSessions) {
      console.log("1. Start the configured session(s)");
      console.log("2. Pair a new WhatsApp account");

      const action = (await rl.question("Select 1 or 2 [1]: ")).trim() || "1";
      if (action === "1") {
        return null;
      }
      if (action !== "2") {
        throw new Error("Invalid choice. Enter 1 to start existing sessions or 2 to pair a new account.");
      }
    }

    console.log("Choose how to link your WhatsApp account:");
    console.log("1. Scan a QR code in the terminal");
    console.log("2. Enter a phone number and use a WhatsApp pairing code");

    const method = (await rl.question("Select 1 or 2: ")).trim();
    if (method !== "1" && method !== "2") {
      throw new Error("Invalid pairing method. Enter 1 for QR or 2 for pairing code.");
    }

    let phoneNumber;
    if (method === "2") {
      const input = (await rl.question("Phone number with country code: ")).trim();
      if (!/^[+\d\s().-]+$/.test(input)) {
        throw new Error("Enter a phone number using digits and standard formatting characters only.");
      }
      phoneNumber = input.replace(/\D/g, "");
      if (!/^\d{8,15}$/.test(phoneNumber)) {
        throw new Error("Enter a valid phone number with country code (8 to 15 digits).");
      }
    }

    return {
      sessionId: randomBytes(9).toString("hex"),
      method: method === "1" ? "qr" : "code",
      phoneNumber,
    };
  } finally {
    rl.close();
  }
}

async function initializeTerminalAuthState(sessionId) {
  const { initAuthCreds } = await import("baileys");
  const authState = new CustomAuthState(sessionId);
  authState.sessionData = {
    creds: initAuthCreds(),
    keys: {},
    dirty: true,
  };
  await authState.saveSession();
}

module.exports = { promptTerminalPairing, initializeTerminalAuthState };
