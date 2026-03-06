require("dotenv").config();
const app = require("./app");
const { connectDB } = require("./config/db");

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`✅ API running: http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server start failed:", err.message);
    process.exit(1);
  }
})();
