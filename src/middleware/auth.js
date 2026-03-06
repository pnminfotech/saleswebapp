const { verifyJwt } = require("../utils/token");
const User = require("../models/User");

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = verifyJwt(token);
    const user = await User.findById(decoded.id).select("-passwordHash");

    if (!user || !user.active) return res.status(401).json({ message: "Unauthorized" });

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

module.exports = { auth };
