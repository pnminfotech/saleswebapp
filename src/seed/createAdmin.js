require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { hashPassword } = require("../utils/hash");

(async () => {
  const uri = process.env.MONGO_URI;
  await mongoose.connect(uri);

  const email = process.argv[2];
  const password = process.argv[3];
  const name = process.argv[4] || "Admin";

  if (!email || !password) {
    console.log("Usage: node src/seed/createAdmin.js admin@email.com password AdminName");
    process.exit(1);
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.log("Admin already exists:", email);
    process.exit(0);
  }

  const user = await User.create({
    name,
    email: email.toLowerCase(),
    role: "admin",
    passwordHash: await hashPassword(password),
    mustResetPassword: false,
    active: true
  });

  console.log("✅ Admin created:", user.email);
  process.exit(0);
})();
