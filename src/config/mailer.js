const nodemailer = require("nodemailer");

function createTransport() {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 587);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;

  if (!host || !user || !pass) {
    throw new Error("Mail SMTP env missing (MAIL_HOST/MAIL_USER/MAIL_PASS)");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass }
  });
}

async function sendMail({ to, subject, html, text }) {
  const mode = (process.env.MAIL_MODE || "smtp").toLowerCase();

  // ✅ Free + best for development/testing
  if (mode === "console") {
    console.log("\n================ EMAIL (CONSOLE MODE) ================");
    console.log("TO:", to);
    console.log("SUBJECT:", subject);
    console.log("TEXT:", text);
    console.log("HTML:", html);
    console.log("======================================================\n");
    return { messageId: "console" };
  }

  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  const transporter = createTransport();
  return transporter.sendMail({ from, to, subject, html, text });
}

module.exports = { sendMail };
