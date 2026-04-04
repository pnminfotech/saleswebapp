const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const segmentRoutes = require("./routes/segmentRoutes");
const targetRoutes = require("./routes/targetRoutes");
const dailyCustomerReportRoutes = require("./routes/dailyCustomerReportRoutes");
const customerRoutes = require("./routes/customerRoutes");
const reportRoutes = require("./routes/reportRoutes");
const companySettingsRoutes = require("./routes/companySettingsRoutes");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 150
  })
);

app.get("/", (req, res) => res.json({ ok: true, message: "Sales MIS API running" }));

app.use("/api/auth", authRoutes);


app.use("/api/admin", adminRoutes);
app.use("/api/segments", segmentRoutes);
app.use("/api/targets", targetRoutes);
app.use("/api/reports/daily-customer", dailyCustomerReportRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/settings", companySettingsRoutes);

app.use(errorHandler);

module.exports = app;
