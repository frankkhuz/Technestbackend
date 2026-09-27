// Loads the /buy catalog (data/catalog.json — extracted from the frontend's
// old hardcoded app/data/gadget.ts) into the Product collection.
//
//   npm run seed:products            insert missing products only
//   npm run seed:products -- --update   also overwrite existing ones' details/prices
//
// Safe to re-run: products are matched by slug, and nothing is deleted.
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { phones, gadgets } = require("../data/catalog.json");

const toDoc = (item, type) =>
  type === "phone"
    ? {
        slug: item.id,
        type,
        name: item.name,
        brand: item.brand,
        category: item.category,
        image: item.image || null,
        storage: item.storage || [],
        colors: item.color || [],
        ram: item.ram || null,
        badge: item.badge || null,
        priceUkUsed: item.priceUkUsed,
        priceBrandNew: item.priceBrandNew,
      }
    : {
        slug: item.id,
        type,
        name: item.name,
        brand: item.brand,
        category: item.gadgetCategory,
        spec: item.spec || null,
        badge: item.badge || null,
        tags: item.tags || [],
        priceUkUsed: item.priceUkUsed,
        priceBrandNew: item.priceBrandNew,
      };

const run = async () => {
  const update = process.argv.includes("--update");
  await mongoose.connect(process.env.MONGO_URI);

  const docs = [
    ...phones.map((p) => toDoc(p, "phone")),
    ...gadgets.map((g) => toDoc(g, "gadget")),
  ];

  const ops = docs.map((doc) => ({
    updateOne: {
      filter: { slug: doc.slug },
      update: update ? { $set: doc } : { $setOnInsert: doc },
      upsert: true,
    },
  }));

  const result = await Product.bulkWrite(ops);
  console.log(
    `Catalog seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated, ${docs.length} total in source.`
  );
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
