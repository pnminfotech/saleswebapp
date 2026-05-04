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
  segmentId: z.string().min(10),
  periodType: z.enum(["MONTH", "QUARTER", "YEAR"]),
  periodKey: z.string().min(3),
  vendorVisitTarget: z.number().finite().nonnegative().optional(),
  newVendorTarget: z.number().finite().nonnegative().optional(),
  salesTarget: z.number().finite().nonnegative().optional(),
  collectionTarget: z.number().finite().nonnegative().optional()
});

const targetSheetAssignmentSchema = z.object({
  salespersonName: z.string().min(1),
  segmentName: z.string().min(1),
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  vendorVisitTarget: z.number().finite().nonnegative().optional(),
  newVendorTarget: z.number().finite().nonnegative().optional(),
  salesTarget: z.number().finite().nonnegative().optional(),
  collectionTarget: z.number().finite().nonnegative().optional(),
});

const targetSheetImportSchema = z.object({
  yearKey: z.string().min(2),
  fileName: z.string().min(1),
  sheetName: z.string().min(1),
  salespersonNames: z.array(z.string().min(1)).default([]),
  segmentNames: z.array(z.string().min(1)).default([]),
  matrix: z.array(z.array(z.any())).min(1),
  assignments: z.array(targetSheetAssignmentSchema).default([]),
});

module.exports = {
  loginSchema,
  forceChangeSchema,
  forgotPasswordSchema,
  adminResetPasswordSchema,
  createSalesSchema,
  updateSalesSchema,
  upsertTargetSchema,
  targetSheetAssignmentSchema,
  targetSheetImportSchema,
};
