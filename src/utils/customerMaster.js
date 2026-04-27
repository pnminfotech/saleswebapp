function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCustomerKey(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, " ");
}

function toTitleCase(value) {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9&/-]+$/.test(word)) return word;
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function buildExactNameRegex(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  if (!normalized) return null;
  const escaped = escapeRegex(normalized).replace(/ /g, "\\s+");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizeClientType(value, fallback = "") {
  const text = normalizeText(value).toLowerCase();
  if (text === "new") return "New";
  if (text === "existing") return "Existing";
  return fallback || "";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCustomerSearchFilter(q) {
  const text = normalizeText(q);
  const filter = { isActive: true };

  if (!text) return filter;

  const regex = { $regex: escapeRegex(text), $options: "i" };
  filter.$or = [
    { name: regex },
    { clientType: regex },
    { area: regex },
    { metTo: regex },
    { designation: regex },
    { segment: regex },
  ];

  return filter;
}

function buildCustomerLookupMap(customers) {
  const map = new Map();

  for (const customer of Array.isArray(customers) ? customers : []) {
    const key = normalizeCustomerKey(customer?.name);
    const customerId = String(customer?._id || "").trim();
    const payload = {
      customerId,
      name: toTitleCase(customer?.name),
      clientType: normalizeClientType(customer?.clientType, "Existing"),
      area: toTitleCase(customer?.area),
      metTo: toTitleCase(customer?.metTo),
      designation: toTitleCase(customer?.designation),
      segment: toTitleCase(customer?.segment),
    };
    if (customerId) {
      map.set(`id:${customerId}`, payload);
    }
    if (!key || map.has(key)) continue;
    map.set(key, payload);
  }

  return map;
}

function buildCustomerSelectFields() {
  return "name clientType area metTo designation segment isActive createdAt updatedAt";
}

function normalizeCustomerUpdate(body = {}, existing = {}) {
  const next = {};

  const name = toTitleCase(body.name);
  if (name) next.name = name;

  const clientType = normalizeClientType(body.clientType ?? body.type ?? body.newOrExisting, existing.clientType || "Existing");
  if (clientType) next.clientType = clientType;

  const area = toTitleCase(body.area);
  if (area) next.area = area;

  const metTo = toTitleCase(body.metTo);
  if (metTo) next.metTo = metTo;

  const designation = toTitleCase(body.designation);
  if (designation) next.designation = designation;

  const segment = toTitleCase(body.segment);
  if (segment) next.segment = segment;

  return next;
}

async function upsertCustomerByName(Customer, body = {}, { createdBy = null } = {}) {
  const name = toTitleCase(body.name);
  if (!name) {
    const err = new Error("Customer name is required");
    err.statusCode = 400;
    throw err;
  }

  const exactRegex = buildExactNameRegex(name);
  const existing = exactRegex
    ? await Customer.findOne({
        name: exactRegex,
      })
    : null;

  const update = normalizeCustomerUpdate(body, existing || {});

  if (existing) {
    existing.set(update);
    await existing.save();
    return existing;
  }

  const payload = {
    name,
    clientType: update.clientType || "Existing",
    area: update.area || "",
    metTo: update.metTo || "",
    designation: update.designation || "",
    segment: update.segment || "",
    createdBy,
    isActive: true,
  };

  return Customer.create(payload);
}

async function upsertCustomerByPreviousName(Customer, previousName, body = {}, { createdBy = null } = {}) {
  const nextName = toTitleCase(body.name);
  if (!nextName) {
    const err = new Error("Customer name is required");
    err.statusCode = 400;
    throw err;
  }

  const previous = toTitleCase(previousName);
  const previousRegex = buildExactNameRegex(previous);
  const nextRegex = buildExactNameRegex(nextName);
  const existingByPrevious = previousRegex
    ? await Customer.findOne({
        name: previousRegex,
      })
    : null;
  const existingByNext = nextRegex
    ? await Customer.findOne({
        name: nextRegex,
      })
    : null;

  const updateSource = existingByNext || existingByPrevious || {};
  const update = normalizeCustomerUpdate(body, updateSource);

  if (existingByPrevious && existingByNext && String(existingByPrevious._id) !== String(existingByNext._id)) {
    existingByNext.set(update);
    existingByNext.name = nextName;
    await existingByNext.save();
    await Customer.deleteOne({ _id: existingByPrevious._id });
    return existingByNext;
  }

  if (existingByPrevious) {
    existingByPrevious.set(update);
    existingByPrevious.name = nextName;
    await existingByPrevious.save();
    return existingByPrevious;
  }

  if (existingByNext) {
    existingByNext.set(update);
    existingByNext.name = nextName;
    await existingByNext.save();
    return existingByNext;
  }

  return Customer.create({
    name: nextName,
    clientType: update.clientType || "Existing",
    area: update.area || "",
    metTo: update.metTo || "",
    designation: update.designation || "",
    segment: update.segment || "",
    createdBy,
    isActive: true,
  });
}

module.exports = {
  buildCustomerLookupMap,
  buildExactNameRegex,
  buildCustomerSearchFilter,
  buildCustomerSelectFields,
  normalizeClientType,
  normalizeCustomerKey,
  normalizeText,
  toTitleCase,
  upsertCustomerByName,
  upsertCustomerByPreviousName,
};
