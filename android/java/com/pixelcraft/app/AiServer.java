package com.pixelcraft.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * PixelCraft local AI tool service (plan B): a loopback-only HTTP endpoint that
 * turns one request into one call of a {@link Handler} and writes the string
 * that comes back to the client.
 *
 * <p>This file is deliberately <b>pure JDK</b> (no {@code import android.*}) so
 * it can be compiled and probe-tested outside an Android build. Everything the
 * Android layer needs is a {@code Handler} implementation (see
 * {@code MainActivity.PixelBridge.aiServerStart}, which forwards the request
 * into the WebView as {@code window.__pc_ai_call(json)}).
 *
 * <p>Contract (keep this in sync with docs/API.md once the integration task
 * writes it down):
 * <ul>
 *   <li>Binds {@code 127.0.0.1} explicitly - never {@code 0.0.0.0}, never the
 *       IPv6 loopback. Pass port {@code 0} to let the OS pick a free port, then
 *       read the real one from {@link #port()}.</li>
 *   <li>Auth: {@code Authorization: Bearer <token>}, compared in constant time.
 *       The token is generated with {@link SecureRandom} (16 bytes -> 32 hex
 *       chars) by {@link #newToken()}; a {@code null}/empty token passed to
 *       {@link #start} is generated on the spot.</li>
 *   <li>{@code GET /ai/health} and {@code POST /ai} are <b>both</b> forwarded to
 *       the handler; the page owns the shape of both answers. The Java side must
 *       not answer health itself: {@code version} / {@code docRev} / {@code tier}
 *       only exist in the TS layer, and a second source of truth would make the
 *       Android and the Node host return different shapes for the same path.</li>
 *   <li>{@code GET /ai} and {@code POST /ai/health} are 405 (method allowance is
 *       the only per-path difference left here), any other path is 404.</li>
 *   <li>A handler result equal to {@link #ERR_JS_NOT_READY} is answered with
 *       HTTP 503 - that body is the bridge saying "the page is not there yet",
 *       which is a transport condition, not a tool result.</li>
 *   <li>The Java side routes and authorises only. It never looks at the call
 *       name, the tool table or the permission tier - that all lives in the TS
 *       layer ({@code window.__pc_ai_call}).</li>
 *   <li>Request bodies are capped at {@link #MAX_BODY_BYTES} (413 above that),
 *       the body is read until Content-Length is satisfied, sockets carry a
 *       read/write timeout, and every failure is logged and swallowed: one bad
 *       client must never take the app down.</li>
 * </ul>
 *
 * <p>Do not "fix" the following, they are load bearing:
 * <ul>
 *   <li>The accept loop runs on a daemon thread and the worker pool has a
 *       bounded queue - an unbounded "thread per connection" design lets any
 *       local process open sockets until the app dies.</li>
 *   <li>{@link #stop()} closes the listening socket, interrupts the pool and
 *       closes the in-flight client sockets, so the port is released at once
 *       and a later {@link #start} on the same port succeeds (SO_REUSEADDR is
 *       set for the same reason).</li>
 * </ul>
 */
public final class AiServer {

    /** Hard request-body ceiling; bigger bodies get 413. */
    public static final int MAX_BODY_BYTES = 1024 * 1024;

    /**
     * The bridge's "there is no page to talk to yet" body. A handler returning
     * exactly this is answered with HTTP 503; it is defined here (and reused by
     * MainActivity) so the two sides cannot drift apart.
     */
    public static final String ERR_JS_NOT_READY = "{\"ok\":false,\"error\":\"js-not-ready\"}";

    /** Receives one already-parsed request; returns the JSON text to send back. */
    public interface Handler {
        /**
         * @param method     upper-case HTTP method ("GET" / "POST")
         * @param path       request path with the query string stripped ("/ai")
         * @param authHeader raw Authorization header value, or null
         * @param body       request body as text ("" when there is none)
         * @return JSON text written back verbatim; null/empty becomes an error
         */
        String handle(String method, String path, String authHeader, String body);
    }

    private static final String LOOPBACK = "127.0.0.1";
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_HEADERS = 100;
    private static final int READ_TIMEOUT_MS = 10000;
    private static final int BACKLOG = 16;
    private static final int CORE_THREADS = 2;
    private static final int MAX_THREADS = 4;
    private static final int QUEUE_CAPACITY = 32;
    private static final long KEEPALIVE_SECONDS = 30L;

    private static final SecureRandom RNG = new SecureRandom();
    private static final Set<Socket> NO_CLIENTS = Collections.emptySet();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private final Object lock = new Object();
    private final Set<Socket> clients = Collections.synchronizedSet(new HashSet<Socket>());

    private volatile ServerSocket server;
    private volatile ThreadPoolExecutor pool;
    private volatile Handler handler;
    private volatile String token = "";
    private volatile boolean running;

    /** 16 random bytes as 32 lower-case hex chars. */
    public static String newToken() {
        byte[] raw = new byte[16];
        RNG.nextBytes(raw);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : raw) {
            sb.append(HEX[(b >> 4) & 0xF]);
            sb.append(HEX[b & 0xF]);
        }
        return sb.toString();
    }

    /**
     * Start listening on {@code 127.0.0.1:port} (port 0 picks a free port) and
     * return the token clients must present. Any previous instance is stopped
     * first, so a repeated start is always a clean restart.
     *
     * @throws IOException if the port cannot be bound
     */
    public synchronized String start(int port, String givenToken, Handler h) throws IOException {
        if (h == null) throw new IllegalArgumentException("handler == null");
        stop();

        String useToken = (givenToken == null || givenToken.isEmpty()) ? newToken() : givenToken;
        ServerSocket ss = new ServerSocket();
        try {
            // loopback only: bind the IPv4 loopback address explicitly instead of
            // relying on the wildcard constructor
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(InetAddress.getByName(LOOPBACK), port), BACKLOG);
        } catch (IOException e) {
            closeQuietly(ss);
            throw e;
        }

        this.server = ss;
        this.token = useToken;
        this.handler = h;
        this.pool = new ThreadPoolExecutor(
                CORE_THREADS, MAX_THREADS, KEEPALIVE_SECONDS, TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(QUEUE_CAPACITY),
                daemonFactory("pc-ai-worker-"),
                new ThreadPoolExecutor.AbortPolicy());
        this.running = true;
        daemonFactory("pc-ai-accept-").newThread(new Runnable() {
            @Override public void run() {
                acceptLoop();
            }
        }).start();
        log("listening on " + LOOPBACK + ":" + ss.getLocalPort());
        return useToken;
    }

    /**
     * Stop listening and close everything that is in flight. Idempotent, never
     * throws: after it returns the port is free again.
     */
    public synchronized void stop() {
        running = false;

        ServerSocket ss = server;
        server = null;
        if (ss != null) closeQuietly(ss); // unblocks accept()

        ThreadPoolExecutor p = pool;
        pool = null;
        if (p != null) {
            p.shutdownNow();
        }

        // unblock workers parked on read()/write() of a live connection
        Set<Socket> live;
        synchronized (clients) {
            live = new HashSet<Socket>(clients);
            clients.clear();
        }
        for (Socket s : (live.isEmpty() ? NO_CLIENTS : live)) closeQuietly(s);

        handler = null;
        token = "";
    }

    public boolean isRunning() {
        ServerSocket ss = server;
        return running && ss != null && !ss.isClosed();
    }

    /** Bound port while running, 0 otherwise. */
    public int port() {
        ServerSocket ss = server;
        if (ss == null || !running) return 0;
        return ss.getLocalPort();
    }

    /** Active token while running, "" otherwise. */
    public String token() {
        return token;
    }

    // ---------------------------------------------------------------- internals

    private void acceptLoop() {
        while (running) {
            ServerSocket ss = server;
            ThreadPoolExecutor p = pool;
            if (ss == null || p == null || ss.isClosed()) return;
            Socket client;
            try {
                client = ss.accept();
            } catch (IOException e) {
                // stop() closed the server socket, or the socket died: leave
                log("accept loop ended: " + e);
                return;
            }
            try {
                client.setSoTimeout(READ_TIMEOUT_MS);
                client.setTcpNoDelay(true);
                clients.add(client);
                p.execute(newConnection(client));
            } catch (RejectedExecutionException busy) {
                clients.remove(client);
                respond(client, 503, "Service Unavailable", errorJson("busy"), null);
                closeQuietly(client);
            } catch (Throwable t) {
                clients.remove(client);
                closeQuietly(client);
                log("accept failed: " + t);
            }
        }
    }

    private Runnable newConnection(final Socket client) {
        return new Runnable() {
            @Override public void run() {
                try {
                    handle(client);
                } catch (Throwable t) {
                    log("connection error: " + t);
                } finally {
                    clients.remove(client);
                    closeQuietly(client);
                }
            }
        };
    }

    /** Parse one request, route it, write exactly one response, never throw. */
    private void handle(Socket client) {
        try {
            InputStream in = new BufferedInputStream(client.getInputStream());
            String requestLine = readLine(in, MAX_HEADER_BYTES);
            if (requestLine == null || requestLine.isEmpty()) {
                respond(client, 400, "Bad Request", errorJson("bad-request"), null);
                return;
            }
            String[] parts = requestLine.split("\\s+");
            if (parts.length < 2) {
                respond(client, 400, "Bad Request", errorJson("bad-request"), null);
                return;
            }
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            int headerBytes = requestLine.length();
            int headerCount = 0;
            long contentLength = -1L;
            String authHeader = null;
            while (true) {
                String line = readLine(in, MAX_HEADER_BYTES);
                if (line == null) return; // client hung up mid-headers
                headerBytes += line.length() + 2;
                if (headerBytes > MAX_HEADER_BYTES) {
                    respond(client, 431, "Request Header Fields Too Large", errorJson("headers-too-large"), null);
                    return;
                }
                if (line.isEmpty()) break;
                if (++headerCount > MAX_HEADERS) {
                    respond(client, 431, "Request Header Fields Too Large", errorJson("too-many-headers"), null);
                    return;
                }
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String name = line.substring(0, colon).trim().toLowerCase(Locale.US);
                String value = line.substring(colon + 1).trim();
                if (name.equals("content-length")) {
                    try {
                        contentLength = Long.parseLong(value);
                    } catch (NumberFormatException e) {
                        contentLength = -1L;
                    }
                } else if (name.equals("authorization")) {
                    authHeader = value;
                }
            }

            // the handler sees the bare path, no query string
            String path = target;
            int question = path.indexOf('?');
            if (question >= 0) path = path.substring(0, question);

            if (!method.equals("GET") && !method.equals("POST")) {
                respond(client, 405, "Method Not Allowed", errorJson("method-not-allowed"), ALLOW_GET_POST);
                return;
            }
            boolean health = path.equals("/ai/health");
            boolean call = path.equals("/ai");
            if (!health && !call) {
                respond(client, 404, "Not Found", errorJson("not-found"), null);
                return;
            }
            if (!authorized(authHeader)) {
                respond(client, 401, "Unauthorized", errorJson("unauthorized"), WWW_AUTH);
                return;
            }
            if (health) {
                if (!method.equals("GET")) {
                    respond(client, 405, "Method Not Allowed", errorJson("method-not-allowed"), ALLOW_GET);
                    return;
                }
            } else if (!method.equals("POST")) {
                respond(client, 405, "Method Not Allowed", errorJson("method-not-allowed"), ALLOW_POST);
                return;
            }
            if (contentLength < 0L) contentLength = 0L;
            if (contentLength > MAX_BODY_BYTES) {
                // do not drain the oversized body: the connection is closed anyway
                respond(client, 413, "Payload Too Large", errorJson("body-too-large"), null);
                return;
            }
            byte[] raw = readExactly(in, (int) contentLength);
            if (raw == null) {
                respond(client, 400, "Bad Request", errorJson("body-truncated"), null);
                return;
            }
            String body = new String(raw, StandardCharsets.UTF_8).trim();

            // health travels the same way as a call: the page is the only place
            // that knows version / docRev / tier
            Handler h = handler;
            String out;
            try {
                out = (h == null) ? errorJson("handler-missing") : h.handle(method, path, authHeader, body);
            } catch (Throwable t) {
                log("handler failed: " + t);
                out = errorJson("handler-error");
            }
            int status = 200;
            String reason = "OK";
            if (out == null || out.trim().isEmpty()) {
                out = errorJson("handler-empty");
            } else if (ERR_JS_NOT_READY.equals(out.trim())) {
                // the bridge has no page to talk to yet
                status = 503;
                reason = "Service Unavailable";
            }
            respond(client, status, reason, out, null);
        } catch (Throwable t) {
            log("request failed: " + t);
            respond(client, 500, "Internal Server Error", errorJson("server-error"), null);
        }
    }

    private static final String ALLOW_GET = "Allow: GET\r\n";
    private static final String ALLOW_POST = "Allow: POST\r\n";
    private static final String ALLOW_GET_POST = "Allow: GET, POST\r\n";
    private static final String WWW_AUTH = "WWW-Authenticate: Bearer\r\n";

    /** Constant-time comparison of the Bearer token against the active one. */
    private boolean authorized(String authHeader) {
        String expected = token;
        if (expected == null || expected.isEmpty() || authHeader == null) return false;
        String given = authHeader.trim();
        if (given.length() > 7 && given.regionMatches(true, 0, "Bearer ", 0, 7)) {
            given = given.substring(7).trim();
        }
        byte[] a = expected.getBytes(StandardCharsets.UTF_8);
        byte[] b = given.getBytes(StandardCharsets.UTF_8);
        int diff = a.length ^ b.length;
        int n = Math.min(a.length, b.length);
        for (int i = 0; i < n; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    private static String errorJson(String code) {
        return "{\"ok\":false,\"error\":\"" + code + "\"}";
    }

    /**
     * Write the one and only response of this connection. The body is passed
     * through verbatim ("single line" is the caller's responsibility - the
     * bridge returns what the page handed it).
     */
    private void respond(Socket client, int status, String reason, String body, String extraHeaders) {
        byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder(192);
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Content-Length: ").append(payload.length).append("\r\n");
        head.append("Connection: close\r\n");
        head.append("Cache-Control: no-store\r\n");
        if (extraHeaders != null) head.append(extraHeaders);
        head.append("\r\n");
        try {
            OutputStream out = client.getOutputStream();
            out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
            out.write(payload);
            out.flush();
        } catch (IOException e) {
            log("write failed: " + e);
        }
    }

    /** Read one CRLF/LF terminated line; null on EOF or beyond the budget. */
    private static String readLine(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(96);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
            if (c == '\r') continue;
            if (buf.size() >= maxBytes) return null;
            buf.write(c);
        }
        if (buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    /** Read exactly n bytes; null when the peer closed early. */
    private static byte[] readExactly(InputStream in, int n) throws IOException {
        if (n <= 0) return new byte[0];
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) return null;
            off += r;
        }
        return buf;
    }

    private static ThreadFactory daemonFactory(final String prefix) {
        final AtomicInteger seq = new AtomicInteger();
        return new ThreadFactory() {
            @Override public Thread newThread(Runnable r) {
                Thread t = new Thread(r, prefix + seq.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        };
    }

    private static void closeQuietly(ServerSocket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }

    /** Tagged stderr line: this class must not depend on android.util.Log. */
    private static void log(String msg) {
        System.err.println("[pc-ai] " + msg);
    }
}
