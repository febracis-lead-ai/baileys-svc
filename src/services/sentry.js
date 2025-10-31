import * as Sentry from "@sentry/bun";

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE || process.env.npm_package_version;
const SENTRY_SAMPLE_RATE = parseFloat(process.env.SENTRY_SAMPLE_RATE || "1.0");
const SENTRY_TRACES_SAMPLE_RATE = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1");
const SENTRY_PROFILES_SAMPLE_RATE = parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || "0.1");

export function initSentry() {
    if (!SENTRY_DSN) {
        console.warn("[Sentry] DSN not configured, monitoring disabled");
        return false;
    }

    Sentry.init({
        dsn: SENTRY_DSN,
        environment: SENTRY_ENVIRONMENT,
        release: SENTRY_RELEASE,

        // Performance Monitoring
        tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
        profilesSampleRate: SENTRY_PROFILES_SAMPLE_RATE,

        // Error Sampling
        sampleRate: SENTRY_SAMPLE_RATE,

        // Filtering
        ignoreErrors: [
            "ECONNRESET",
            "ETIMEDOUT",
            "ENOTFOUND",
            "ERR_NETWORK",
            "NetworkError",
            "Network request failed",
        ],

        beforeSend(event, hint) {
            console.log("[Sentry] beforeSend called:", {
                url: event.request?.url,
                message: event.message,
                exception: event.exception?.values?.[0]?.value
            });

            // Filter sensitive data
            if (event.request?.headers) {
                delete event.request.headers["x-api-key"];
                delete event.request.headers["authorization"];
            }

            if (event.request?.cookies) {
                delete event.request.cookies;
            }

            // Don't send health check errors
            if (event.request?.url?.includes("/healthz") || event.request?.url?.includes("/favicon.ico")) {
                console.log("[Sentry] Filtering out healthz/favicon");
                return null;
            }

            console.log("[Sentry] Sending event to Sentry");
            return event;
        },

        beforeBreadcrumb(breadcrumb) {
            // Filter sensitive breadcrumbs
            if (breadcrumb.category === "http" && breadcrumb.data?.url) {
                const url = breadcrumb.data.url;
                if (url.includes("api_key") || url.includes("token")) {
                    breadcrumb.data.url = url.replace(/([?&])(api_key|token)=[^&]*/gi, "$1$2=***");
                }
            }

            return breadcrumb;
        },
    });

    console.log(`[Sentry] Initialized (env: ${SENTRY_ENVIRONMENT}, release: ${SENTRY_RELEASE})`);
    return true;
}

export function captureException(error, context = {}) {
    Sentry.captureException(error, {
        extra: context,
    });
}

export function captureMessage(message, level = "info", context = {}) {
    Sentry.captureMessage(message, {
        level,
        extra: context,
    });
}

export function setUser(user) {
    Sentry.setUser(user);
}

export function setContext(name, context) {
    Sentry.getCurrentScope().setContext(name, context);
}

export function addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb);
}

export function startSpan(options, callback) {
    return Sentry.startSpan(options, callback);
}

export { Sentry };