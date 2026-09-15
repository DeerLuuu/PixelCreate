package com.pixelcraft.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.VibratorManager;
import android.os.Vibrator;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final String TAG = "PixelCraft";
    private static final int REQ_CREATE = 1001;
    private static final int REQ_OPEN = 1002;
    /** how long a local-service request waits for the page to answer it */
    private static final long AI_CALL_TIMEOUT_MS = 10000L;

    private static final String AI_ERR_TIMEOUT = "{\"ok\":false,\"error\":\"timeout\"}";
    private static final String AI_ERR_JS = "{\"ok\":false,\"error\":\"js-error\"}";
    private static final String AI_ERR_ASYNC = "{\"ok\":false,\"error\":\"js-async-unsupported\"}";
    private static final String AI_ERR_EMPTY = "{\"ok\":false,\"error\":\"empty-response\"}";
    private static final String AI_ERR_SHUTDOWN = "{\"ok\":false,\"error\":\"shutdown\"}";

    private WebView web;
    /** true while the system bars are hidden (the immersive setting) */
    private boolean immersive = true;
    private final Queue<PendingSave> pendingSaves = new LinkedList<>();
    private String pendingOpenMime = "*/*";
    /** the 127.0.0.1 AI tool service; off until the page turns it on */
    private final AiServer aiServer = new AiServer();
    /** bridge calls still waiting for their answer (fast path or aiRespond) */
    private final PendingCalls pendingCalls = new PendingCalls();

    static class PendingSave {
        String name, mime, b64, reqId;
        PendingSave(String name, String mime, String b64, String reqId) {
            this.name = name; this.mime = mime; this.b64 = b64; this.reqId = reqId;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // draw into the notch / punch-hole area; the web layer keeps its own
        // controls out of it via the safe-area insets reported to JS
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            try {
                getWindow().getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            } catch (Throwable ignored) { /* older ROMs */ }
        }
        hideSystemUi();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        web.setBackgroundColor(0xFF14151A);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "PixelBridge");
        // the app owns long-press gestures: suppress Android's native text-selection
        // context menus (keep them working only inside editable inputs)
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                try {
                    WebView.HitTestResult hr = web.getHitTestResult();
                    if (hr != null && hr.getType() == WebView.HitTestResult.EDIT_TEXT_TYPE) return false;
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e(TAG, "webview error " + errorCode + " " + description + " @ " + failingUrl);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "[js:" + cm.lineNumber() + "] " + cm.message());
                return true;
            }
        });

        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    private void hideSystemUi() {
        immersive = true;
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    /** bring the status + navigation bars back (immersion off) */
    private void showSystemUi() {
        immersive = false;
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) hideSystemUi();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // ensure the WebView re-lays out so CSS media queries (portrait/landscape)
        // re-evaluate after a rotation
        if (web != null) web.post(new Runnable() {
            @Override public void run() {
                web.requestLayout();
                web.invalidate();
            }
        });
    }

    private void eval(final String js) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private final class Bridge {
        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64data, final String reqId) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    pendingSaves.add(new PendingSave(name, mime, base64data, reqId));
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(i, REQ_CREATE);
                    } catch (Exception e) {
                        pendingSaves.poll();
                        eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":false,\"err\":\"intent\"}')}))");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openFile(final String mime) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    pendingOpenMime = (mime == null || mime.isEmpty()) ? "*/*" : mime;
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(pendingOpenMime);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_OPEN);
                    } catch (Exception e) {
                        eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:{ok:false}}))");
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** the vibrator to use: VibratorManager on API 31+, the legacy service
         *  below that (the deprecated constant still works, but the manager is
         *  the documented path and is what some OEMs honour) */
        private Vibrator defaultVibrator() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    if (vm != null) return vm.getDefaultVibrator();
                }
            } catch (Throwable ignored) { /* fall through */ }
            try {
                return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            } catch (Throwable ignored) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean hasVibrator() {
            try {
                Vibrator v = defaultVibrator();
                return v != null && v.hasVibrator();
            } catch (Throwable ignored) {
                return false;
            }
        }

        /** Run one pulse right now and report whether the vibrator accepted
         *  it. Called synchronously from JS (no UI-thread hop) so the page can
         *  tell the difference between "no vibrator" and "it worked". */
        @JavascriptInterface
        public boolean vibrate(final long ms) {
            try {
                Vibrator v = defaultVibrator();
                if (v == null || !v.hasVibrator()) return false;
                long d = Math.max(10, Math.min(ms, 200));
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    try {
                        // full amplitude: DEFAULT_AMPLITUDE can be imperceptible
                        // for very short pulses on some ROMs
                        v.vibrate(VibrationEffect.createOneShot(d, 255));
                    } catch (Throwable e) {
                        v.vibrate(d);
                    }
                } else {
                    v.vibrate(d);
                }
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        /** Window insets in CSS px as "top,bottom,left,right". Uses the insets
         *  *ignoring visibility* so they stay correct while the bars are hidden
         *  in immersive mode (the gesture area and the notch do not go away). */
        @JavascriptInterface
        public String insets() {
            int t = 0, b = 0, l = 0, r = 0;
            try {
                View decor = getWindow().getDecorView();
                WindowInsets wi = decor.getRootWindowInsets();
                if (wi != null) {
                    if (android.os.Build.VERSION.SDK_INT >= 30) {
                        android.graphics.Insets in = wi.getInsetsIgnoringVisibility(
                                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                        t = in.top; b = in.bottom; l = in.left; r = in.right;
                    } else {
                        t = wi.getStableInsetTop();
                        b = wi.getStableInsetBottom();
                        l = wi.getStableInsetLeft();
                        r = wi.getStableInsetRight();
                        android.view.DisplayCutout dc = wi.getDisplayCutout();
                        if (dc != null) {
                            t = Math.max(t, dc.getSafeInsetTop());
                            b = Math.max(b, dc.getSafeInsetBottom());
                            l = Math.max(l, dc.getSafeInsetLeft());
                            r = Math.max(r, dc.getSafeInsetRight());
                        }
                    }
                }
            } catch (Throwable ignored) { /* no insets available */ }
            float d = getResources().getDisplayMetrics().density;
            if (d <= 0f) d = 1f;
            return Math.round(t / d) + "," + Math.round(b / d) + ","
                    + Math.round(l / d) + "," + Math.round(r / d);
        }

        /** hide (true) / show (false) the system bars (immersive setting) */
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) hideSystemUi();
                    else showSystemUi();
                }
            });
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /**
         * Start the loopback AI tool service on 127.0.0.1:port (port 0 = let the
         * OS pick) and return the token the caller has to send as
         * "Authorization: Bearer &lt;token&gt;". Returns "" when the port cannot
         * be bound - the page treats that as "service unavailable".
         *
         * <p>Called on the WebView JavaBridge thread; binding a ServerSocket is
         * immediate, so it is done inline instead of hopping threads.
         */
        @JavascriptInterface
        public String aiServerStart(final int port) {
            try {
                String token = AiServer.newToken();
                aiServer.start(port, token, new AiServer.Handler() {
                    @Override public String handle(String method, String path, String authHeader, String body) {
                        // the request crosses back into the page; all routing,
                        // tool lookup and permission checks belong to the TS layer
                        return aiForwardToJs(method, path, body);
                    }
                });
                return aiServer.token();
            } catch (Throwable e) {
                Log.e(TAG, "ai server start failed", e);
                return "";
            }
        }

        /** Release the port right away; a later start on the same port works. */
        @JavascriptInterface
        public void aiServerStop() {
            try {
                // release parked server threads first so none of them outlives
                // the service (they answer with the shutdown code if the socket
                // is still open)
                aiFailPending();
                aiServer.stop();
            } catch (Throwable e) {
                Log.w(TAG, "ai server stop failed", e);
            }
        }

        /**
         * Deliver the answer of a bridge call that suspended itself by returning
         * an empty string from {@code window.__pc_ai_call(envelope, requestId)}.
         *
         * <p>Unknown, already answered or timed-out request ids are ignored and
         * logged - never thrown back into the page. The first response for an id
         * wins; anything after that is a duplicate.
         *
         * @return true when this call delivered the response
         */
        @JavascriptInterface
        public boolean aiRespond(final String requestId, final String json) {
            try {
                if (requestId == null || requestId.isEmpty()) return false;
                PendingCall pending = pendingCalls.take(requestId);
                if (pending == null) {
                    Log.w(TAG, "aiRespond: unknown or expired request " + requestId);
                    return false;
                }
                if (!pending.offer(json == null ? AI_ERR_EMPTY : json)) {
                    Log.w(TAG, "aiRespond: duplicate response for " + requestId);
                    return false;
                }
                return true;
            } catch (Throwable e) {
                Log.w(TAG, "aiRespond failed", e);
                return false;
            }
        }

        /**
         * One-line status JSON, e.g. {"running":true,"port":8787,"token":"..."}.
         * The token is included so a page reload can pick the running service
         * back up; it is only readable from the app's own JS.
         */
        @JavascriptInterface
        public String aiServerStatus() {
            boolean running = aiServer.isRunning();
            return "{\"running\":" + running + ",\"port\":" + aiServer.port()
                    + ",\"token\":" + jsStringLiteral(running ? aiServer.token() : "") + "}";
        }
    }

    /**
     * Hand one local-service request to the page as
     * {@code window.__pc_ai_call(envelopeJson, requestId)} and wait up to
     * AI_CALL_TIMEOUT_MS for its answer. Runs on a server worker thread - the UI
     * thread hop is via web.post, never a blocking call on the UI thread itself.
     *
     * <p>Two ways back: the page returns the response JSON synchronously (fast
     * path, every synchronous tool), or it returns an empty string meaning "I
     * will call back" and later delivers through
     * {@code PixelBridge.aiRespond(requestId, json)} - that is how a destructive
     * tool's asynchronous confirmation box answers. The connection's worker
     * thread stays parked on the pending call for at most 10 s.
     */
    private String aiForwardToJs(final String method, final String path, final String body) {
        // the body travels as a JSON string so a malformed body can never break
        // the envelope: the page does JSON.parse(envelope.body)
        final String envelope = "{\"method\":" + jsStringLiteral(method)
                + ",\"path\":" + jsStringLiteral(path)
                + ",\"body\":" + jsStringLiteral(body == null ? "" : body) + "}";
        final WebView w = web;
        if (w == null) return AiServer.ERR_JS_NOT_READY;

        final String requestId = UUID.randomUUID().toString();
        final String js = "(function(){try{"
                + "if(typeof window.__pc_ai_call!=='function')return " + jsStringLiteral(AiServer.ERR_JS_NOT_READY) + ";"
                + "var r=window.__pc_ai_call(" + jsStringLiteral(envelope) + "," + jsStringLiteral(requestId) + ");"
                + "if(r&&typeof r.then==='function')return " + jsStringLiteral(AI_ERR_ASYNC) + ";"
                + "return (r===undefined||r===null)?" + jsStringLiteral(AI_ERR_EMPTY) + ":String(r);"
                + "}catch(e){return " + jsStringLiteral(AI_ERR_JS) + ";}})()";

        final PendingCall pending = pendingCalls.begin(requestId);
        w.post(new Runnable() {
            @Override public void run() {
                try {
                    w.evaluateJavascript(js, new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            // evaluateJavascript JSON-encodes a string result, so
                            // the page's JSON arrives quoted and escaped
                            String v = jsonDecodeString(value);
                            if (v == null) {
                                // undefined / null: a broken page, not "wait for me"
                                pending.offer(AI_ERR_EMPTY);
                            } else if (!v.isEmpty()) {
                                pending.offer(v); // fast path
                            }
                            // "" = suspended; aiRespond(requestId, json) will deliver
                        }
                    });
                } catch (Throwable e) {
                    Log.e(TAG, "ai call failed", e);
                    pending.offer(AI_ERR_JS);
                }
            }
        });
        try {
            if (!pending.await(AI_CALL_TIMEOUT_MS)) return AI_ERR_TIMEOUT;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return AI_ERR_TIMEOUT;
        } finally {
            // a late aiRespond must not find this call any more
            pendingCalls.drop(requestId);
        }
        String out = pending.result();
        return (out == null || out.isEmpty()) ? AI_ERR_EMPTY : out;
    }

    /** Settle every parked bridge call (service stop / activity destroy). */
    private void aiFailPending() {
        int n = pendingCalls.failAll(AI_ERR_SHUTDOWN);
        if (n > 0) Log.w(TAG, "ai server: settled " + n + " pending bridge call(s)");
    }

    /**
     * In-flight bridge calls, keyed by request id. Pure JDK on purpose: the
     * bookkeeping (single delivery, timeout, unknown id) can then be exercised
     * without an Android runtime.
     */
    private static final class PendingCalls {
        private final ConcurrentHashMap<String, PendingCall> map = new ConcurrentHashMap<>();

        PendingCall begin(String requestId) {
            PendingCall call = new PendingCall();
            map.put(requestId, call);
            return call;
        }

        /** one-shot lookup: only the first caller gets the call to answer */
        PendingCall take(String requestId) {
            if (requestId == null) return null;
            return map.remove(requestId);
        }

        /**
         * Answer a call by id.
         *
         * @return true only for the first response of a known, still-waiting id
         */
        boolean deliver(String requestId, String json) {
            PendingCall call = take(requestId);
            return call != null && call.offer(json);
        }

        /** forget a call that already finished (timeout / already delivered) */
        void drop(String requestId) {
            if (requestId != null) map.remove(requestId);
        }

        /** settle everything left; returns how many were settled */
        int failAll(String json) {
            int done = 0;
            for (String id : new ArrayList<String>(map.keySet())) {
                if (deliver(id, json)) done++;
            }
            return done;
        }

        int size() {
            return map.size();
        }
    }

    /** One parked bridge call: the first response wins, later ones are refused. */
    private static final class PendingCall {
        private final CountDownLatch done = new CountDownLatch(1);
        private final AtomicBoolean settled = new AtomicBoolean(false);
        private volatile String result;

        boolean offer(String json) {
            if (!settled.compareAndSet(false, true)) return false;
            result = json;
            done.countDown();
            return true;
        }

        boolean await(long timeoutMs) throws InterruptedException {
            return done.await(timeoutMs, TimeUnit.MILLISECONDS);
        }

        String result() {
            return result;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CREATE) {
            PendingSave ps = pendingSaves.poll();
            if (resultCode == RESULT_OK && data != null && data.getData() != null && ps != null) {
                try {
                    Uri uri = data.getData();
                    OutputStream os = getContentResolver().openOutputStream(uri, "w");
                    byte[] bytes = Base64.decode(ps.b64, Base64.DEFAULT);
                    os.write(bytes);
                    os.flush();
                    os.close();
                    eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":true,\"reqId\":\"" + jsSafe(ps.reqId) + "\",\"name\":\"" + jsSafe(ps.name) + "\"}')}))");
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "save fail", e);
                }
            }
            eval("window.dispatchEvent(new CustomEvent('pcsave',{detail:JSON.parse('{\"ok\":false,\"reqId\":\"" + (ps != null ? jsSafe(ps.reqId) : "") + "\"}')}))");
        } else if (requestCode == REQ_OPEN) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                try {
                    Uri uri = data.getData();
                    InputStream is = getContentResolver().openInputStream(uri);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();
                    String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    String name = queryDisplayName(uri);
                    String mime = getContentResolver().getType(uri);
                    eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:JSON.parse('{\"ok\":true,\"name\":\"" + jsSafe(name) + "\",\"mime\":\"" + jsSafe(mime) + "\",\"data\":\"" + b64 + "\"}')}))");
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "open fail", e);
                }
            }
            eval("window.dispatchEvent(new CustomEvent('pcopen',{detail:{ok:false}}))");
        }
    }

    private String queryDisplayName(Uri uri) {
        try {
            String[] proj = {"_display_name"};
            android.database.Cursor c = getContentResolver().query(uri, proj, null, null, null);
            if (c != null) {
                if (c.moveToFirst()) return c.getString(0);
                c.close();
            }
        } catch (Exception ignored) { }
        String p = uri.getPath();
        int idx = p == null ? -1 : p.lastIndexOf('/');
        return idx >= 0 ? p.substring(idx + 1) : "file";
    }

    private static String jsSafe(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    /**
     * Full JS/JSON string literal (quotes, backslashes, newlines and every
     * other control char). jsSafe() is kept as-is for the older call sites
     * because they build JSON through JSON.parse('...') and rely on that shape.
     */
    private static String jsStringLiteral(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    // control chars plus the two JS line separators
                    if (c < 0x20 || c == '\u2028' || c == '\u2029') {
                        sb.append("\\u");
                        sb.append(Character.forDigit((c >> 12) & 0xF, 16));
                        sb.append(Character.forDigit((c >> 8) & 0xF, 16));
                        sb.append(Character.forDigit((c >> 4) & 0xF, 16));
                        sb.append(Character.forDigit(c & 0xF, 16));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /**
     * Undo evaluateJavascript's JSON encoding of a string result ("{\"a\":1}"
     * arrives as "\"{\\\"a\\\":1}\""). Tolerates non-string values by returning
     * them trimmed, so a page returning an object literal still gets through.
     */
    private static String jsonDecodeString(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || "null".equals(s)) return null;
        if (s.length() < 2 || s.charAt(0) != '"' || s.charAt(s.length() - 1) != '"') return s;
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 1; i < s.length() - 1; i++) {
            char c = s.charAt(i);
            if (c != '\\') {
                out.append(c);
                continue;
            }
            i++;
            if (i >= s.length() - 1) break;
            char e = s.charAt(i);
            switch (e) {
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (i + 4 < s.length()) {
                        try {
                            out.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException ignored) { /* keep it as text */ }
                    }
                    break;
                default: out.append(e);
            }
        }
        return out.toString();
    }

    @Override
    protected void onDestroy() {
        // never leave the local tool service listening once the UI is gone, and
        // never leave a server thread parked on a callback that can no longer come
        try {
            aiFailPending();
            aiServer.stop();
        } catch (Throwable ignored) { /* shutdown best effort */ }
        super.onDestroy();
    }

    @Override
    @SuppressLint("ObsoleteSdkInt")
    public void onBackPressed() {
        if (web != null) {
            // __pc_back() returns a REAL boolean: evaluateJavascript JSON-encodes
            // strings, so returning 'true' as a string arrives as "\"true\"" and
            // every press would fall through to finish(). Ask for a boolean and
            // still strip quotes in case the page returns one.
            web.evaluateJavascript(
                    "(function(){try{return window.__pc_back?window.__pc_back()===true:false;}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            String v = value == null ? "" : value.trim().replace("\"", "");
                            if (!"true".equalsIgnoreCase(v)) finish();
                        }
                    });
        } else {
            finish();
        }
    }
}
