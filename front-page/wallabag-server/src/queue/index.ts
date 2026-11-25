import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config/index.js";
import { processUrl } from "./jobs/process-url.js";
import { processEmail } from "./jobs/process-email.js";
import { processText } from "./jobs/process-text.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const articleQueue = new Queue("article-processing", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export function createWorker(): Worker {
  const worker = new Worker("article-processing", async (job) => {
    if (job.name === "process-email") return processEmail(job);
    if (job.name === "process-text") return processText(job);
    return processUrl(job);
  }, {
    connection: redis,
    concurrency: 2,
  });
  return worker;
}
