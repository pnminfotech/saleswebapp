const express = require("express");
const router = express.Router();

const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const auth = typeof authModule === "function" ? authModule : authModule.auth;

const c = require("../controllers/customerController");

// sales + admin both can search
router.get("/search", auth, requireRole("admin", "sales"), c.searchCustomers);
router.get("/", auth, requireRole("admin", "sales"), c.listCustomers);

// admin maintains the shared customer master
router.post("/", auth, requireRole("admin"), c.createCustomer);
router.put("/:id", auth, requireRole("admin"), c.updateCustomer);

module.exports = router;
