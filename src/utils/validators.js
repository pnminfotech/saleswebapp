const { z } = require("zod");

const loginSchema = z.object({
  userId: z.string().min(3),
  password: z.string().min(4)
});

const forceChangeSchema = z.object({
  newPassword: z.string().min(6)
});

const forgotPasswordSchema = z.object({
  userId: z.string().min(3),
  note: z.string().max(250).optional()
});

const createSalesSchema = z.object({
  name: z.string().min(2),
  userId: z.string().min(3),
  email: z.string().email().optional(),
  phone: z.string().optional()
});

const updateSalesSchema = z.object({
  name: z.string().min(2),
  userId: z.string().min(3),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  active: z.boolean().optional()
});

const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(6)
});

const upsertTargetSchema = z.object({
  userId: z.string().min(10),
  periodType: z.enum(["MONTH", "QUARTER", "YEAR"]),
  periodKey: z.string().min(3),
  vendorVisitTarget: z.number().optional(),
  newVendorTarget: z.number().optional(),
  salesTarget: z.number().optional(),
  collectionTarget: z.number().optional()
});

module.exports = {
  loginSchema,
  forceChangeSchema,
  forgotPasswordSchema,
  adminResetPasswordSchema,
  createSalesSchema,
  updateSalesSchema,
  upsertTargetSchema
};
