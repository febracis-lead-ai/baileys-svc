import * as Sentry from "@sentry/bun";

export function sentryRequestHandler() {
    return (req, res, next) => {
        Sentry.continueTrace(
            { sentryTrace: req.headers["sentry-trace"], baggage: req.headers.baggage },
            () => {
                Sentry.startSpan(
                    {
                        name: `${req.method} ${req.path}`,
                        op: "http.server",
                        attributes: {
                            "http.method": req.method,
                            "http.url": req.originalUrl,
                            "http.route": req.path,
                        },
                    },
                    (span) => {
                        Sentry.getCurrentScope().setContext("request", {
                            method: req.method,
                            url: req.originalUrl,
                            headers: sanitizeHeaders(req.headers),
                            ip: req.ip,
                        });

                        res.on("finish", () => {
                            if (span) {
                                span.setStatus({
                                    code: res.statusCode >= 400 ? 2 : 1,
                                });
                                span.setAttribute("http.status_code", res.statusCode);
                            }
                        });
                    }
                );
            }
        );

        next();
    };
}

export function sentryErrorHandler() {
    return (err, req, res, next) => {
        Sentry.withScope((scope) => {
            scope.setContext("request", {
                method: req.method,
                url: req.originalUrl,
                headers: sanitizeHeaders(req.headers),
                body: req.body,
                params: req.params,
                query: req.query,
            });

            scope.setExtra("statusCode", err.status || 500);

            if (req.params?.id) {
                scope.setTag("session_id", req.params.id);
            }

            Sentry.captureException(err);
        });

        next(err);
    };
}

function sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    delete sanitized["x-api-key"];
    delete sanitized["authorization"];
    delete sanitized["cookie"];
    return sanitized;
}