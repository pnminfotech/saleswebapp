const express = require("express");
const router = express.Router();

const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const auth = typeof authModule === "function" ? authModule : authModule.auth;

const c = require("../controllers/customerController");

// sales + admin both can search
router.get("/search", auth, requireRole("admin", "sales"), c.searchCustomers);

// optional: allow sales to add customer (for NEW entries) or admin only if you want strict
router.post("/", auth, requireRole("admin", "sales"), c.createCustomer);

module.exports = router;
