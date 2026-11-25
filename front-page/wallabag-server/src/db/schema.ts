import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const articles = sqliteTable("articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  title: text("title"),
  status: text("status", { enum: ["queued", "processing", "extracting", "cleaning", "generating", "done", "failed"] })
    .notNull()
    .default("queued"),
  isArchived: integer("is_archived").notNull().default(0),
  error: text("error"),
  author: text("author"),
  publishedDate: text("published_date"),
  content: text("content"),
  tags: text("tags"),
  epubPath: text("epub_path"),
  canonicalUrl: text("canonical_url"),
  chatId: integer("chat_id").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;

// Subscription tables for blog monitoring
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  chatId: integer("chat_id").notNull(),
  blogUrl: text("blog_url").notNull(),
  blogTitle: text("blog_title"),
  feedUrl: text("feed_url"),
  sitemapUrl: text("sitemap_url"),
  monitorType: text("monitor_type", { enum: ["rss", "sitemap"] }).notNull(),
  lastChecked: integer("last_checked"),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("subscriptions_user_blog_idx").on(table.userId, table.blogUrl),
]);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export const seenEntries = sqliteTable("seen_entries", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id),
  entryId: text("entry_id").notNull(),
  url: text("url").notNull(),
  firstSeen: integer("first_seen").notNull(),
  notified: integer("notified").notNull().default(0),
}, (table) => [
  uniqueIndex("seen_entries_sub_entry_idx").on(table.subscriptionId, table.entryId),
]);

export type SeenEntry = typeof seenEntries.$inferSelect;
export type NewSeenEntry = typeof seenEntries.$inferInsert;
