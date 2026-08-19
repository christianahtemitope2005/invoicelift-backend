import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config/env.js";
import {
  startFacilityMonitor,
  startInvoiceTimeoutMonitor,
  startRepaymentReminderMonitor,
} from "./jobs/index.js";
import { standardErrorHandler } from "./lib/errors.js";
import { startLedgerReconciliationMonitor } from "./jobs/ledgerReconciliation.js";
import { facilityDeps } from "./lib/facilityDeps.js";
import { fastifyLoggerOptions } from "./lib/logger.js";
import { createMailTransport } from "./lib/mailer.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1/index.js";

export async function buildServer() {
  const app = Fastify({ ...fastifyLoggerOptions() });

  // Normalizes every unhandled error (thrown ApiErrors, Zod validation
  // errors, Fastify's own 4xx/5xx) into the standard `{error:{code,message,
  // details}}` envelope, and hides internal error messages outside dev.
  app.setErrorHandler(standardErrorHandler);

  await app.register(cors, {
    origin: config.corsOrigin,
  });

  // IP-based rate limiting on public endpoints: 100 req/min per IP by
  // default (configurable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS). Replies
  // 429 with a Retry-After header once exceeded.
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "InvoiceLift API",
        description:
          "REST facade for Soroban contracts and indexers. No authentication is currently " +
          "required on any endpoint — every route below is public (see rate limiting for abuse " +
          "protection).",
        version: "0.1.0",
      },
      servers: [{ url: config.apiPrefix, description: "API root" }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(healthRoutes);
  await app.register(v1Routes, { prefix: config.apiPrefix });

  const monitor = config.enableFacilityMonitor ? startFacilityMonitor(facilityDeps) : null;
  const invoiceTimeoutMonitor = config.enableInvoiceTimeoutMonitor
    ? startInvoiceTimeoutMonitor(facilityDeps.prisma)
    : null;
  const repaymentReminderMonitor = config.enableRepaymentReminderMonitor
    ? startRepaymentReminderMonitor(facilityDeps.prisma, createMailTransport())
    : null;
  const reconciliationMonitor = config.enableLedgerReconciliation
    ? startLedgerReconciliationMonitor(
        facilityDeps.prisma,
        facilityDeps.onChainClient,
        config.ledgerReconciliationIntervalMinutes,
      )
    : null;

  app.addHook("onClose", async () => {
    reconciliationMonitor?.stop();
    monitor?.stop();
    invoiceTimeoutMonitor?.stop();
    repaymentReminderMonitor?.stop();
    await facilityDeps.prisma.$disconnect();
  });

  return app;
}
