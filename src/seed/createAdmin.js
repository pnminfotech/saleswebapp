require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { hashPassword } = require("../utils/hash");

(async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      console.error("MONGO_URI missing in .env");
      process.exit(1);
    }

    await mongoose.connect(uri);

    const email = String(process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const password = String(process.argv[3] || process.env.ADMIN_PASSWORD || "").trim();
    const name = String(process.argv[4] || process.env.ADMIN_NAME || "Admin").trim() || "Admin";
    const userIdInput = String(process.argv[5] || process.env.ADMIN_USER_ID || "").trim().toLowerCase();

    if (!email || !password) {
      console.log("Usage: node src/seed/createAdmin.js admin@email.com password AdminName [userId]");
      process.exit(1);
    }

    const userId = userIdInput || email.split("@")[0];
    const existing = await User.findOne({
      $or: [{ email }, { userId }]
    });

    if (existing) {
      console.log("Admin already exists:", existing.email || email);
      process.exit(0);
    }

    const user = await User.create({
      name,
      userId,
      email,
      role: "admin",
      passwordHash: await hashPassword(password),
      mustResetPassword: false,
      active: true
    });

    console.log("Admin created:", user.email, "| userId:", user.userId || "-");
    process.exit(0);
  } catch (err) {
    console.error("Failed to create admin:", err.message);
    process.exit(1);
  }
})();
