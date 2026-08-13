// OpenTelemetry wiring for infra/api.
//
// Exports traces via OTLP/HTTP to the lab Tempo instance
// (infra/self-hosted-stack, otlp receiver, profile: observability) when
// present, or to any endpoint set via OTEL_EXPORTER_OTLP_ENDPOINT. If no
// collector is listening, the exporter fails to connect in the background
// and the request is unaffected — this must never block or crash the API.
//
// Enable with OTEL_ENABLED=true (opt-in; default off so normal dev/CI runs
// never depend on a collector being reachable).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, type Span, SpanStatusCode } from '@opentelemetry/api';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'solo-empire-api';
const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | undefined;

export function startTelemetry(): void {
  if (process.env.OTEL_ENABLED !== 'true') return;
  if (sdk) return; // already started

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'unknown',
    }),
    traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();
  process.on('SIGTERM', () => void stopTelemetry());
  process.on('SIGINT', () => void stopTelemetry());
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown().catch(() => undefined);
  sdk = undefined;
}

const tracer = trace.getTracer(SERVICE_NAME);

/**
 * Wrap a request handler in a span named after the route. Kept manual
 * (rather than relying only on HttpInstrumentation's auto spans) so route
 * path and outcome are recorded even when OTEL_ENABLED=false — in that
 * case getTracer() returns an inert no-op tracer, so this is a free no-op.
 */
export async function withRequestSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
