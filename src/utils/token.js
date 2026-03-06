const jwt = require("jsonwebtoken");

function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign(payload, secret, { expiresIn });
}

function verifyJwt(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signJwt, verifyJwt };
