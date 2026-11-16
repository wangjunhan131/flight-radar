package com.example.flightradar;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 内嵌在 App 里的极简 HTTP 服务，只做两件事：
 *
 *   1. 把 www 目录下的前端文件发给 WebView（同源，避免 file:// 的各种限制）
 *   2. /api/fetch?u=<url> 通用代理 —— adsb.lol / adsb.fi / opensky 都没有 CORS 头，
 *      浏览器/WebView 不能直连，必须由本地服务端转发。只放行白名单主机。
 *
 * 刻意不依赖任何 android.* API，所以可以先用本机 JDK 跑起来做端到端测试
 * （见 tools/serve-test.sh），编译进 APK 时行为完全一致。
 */
public class AssetServer {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";

    /** 允许代理的主机（含子域） */
    private static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(
            "adsb.lol", "adsb.fi", "opensky-network.org", "adsbdb.com",
            "ipwho.is", "ipinfo.io", "autonavi.com"
    ));

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("txt", "text/plain; charset=utf-8");
    }

    private final ServerSocket serverSocket;
    private final Path root;
    private volatile boolean running = true;

    public AssetServer(Path root) throws IOException {
        this.root = root.toAbsolutePath().normalize();
        this.serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(this::acceptLoop, "fr-asset-server");
        t.setDaemon(true);
        t.start();
    }

    public int getPort() {
        return serverSocket.getLocalPort();
    }

    public void stop() {
        running = false;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = serverSocket.accept();
                Thread t = new Thread(() -> handle(s), "fr-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running) {
                    // 端口被关掉时正常退出
                }
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            InputStream in = s.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            // 吃掉剩余请求头
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                // 不需要任何请求头
            }

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            if (!"GET".equals(method)) {
                respond(s.getOutputStream(), 405, "text/plain", "method not allowed".getBytes(StandardCharsets.UTF_8));
                return;
            }

            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }

            OutputStream out = s.getOutputStream();
            if ("/api/health".equals(path)) {
                respond(out, 200, "application/json", "{\"ok\":true,\"app\":\"flightradar\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }
            if ("/api/fetch".equals(path)) {
                handleProxy(out, query);
                return;
            }
            handleStatic(out, path);
        } catch (Exception e) {
            // 单个连接失败不影响服务
        }
    }

    private void handleProxy(OutputStream out, String query) throws IOException {
        String target = param(query, "u");
        if (target == null || target.isEmpty()) {
            respond(out, 400, "application/json", "{\"error\":\"missing u\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }
        URL url;
        try {
            url = new URL(target);
        } catch (Exception e) {
            respond(out, 400, "application/json", "{\"error\":\"bad url\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (!"https".equals(url.getProtocol()) || !hostAllowed(url.getHost())) {
            respond(out, 403, "application/json", "{\"error\":\"host not allowed\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "*/*");
            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] body = is == null ? new byte[0] : readAll(is);
            String ct = conn.getContentType();
            if (ct == null) ct = "application/octet-stream";
            respond(out, code, ct, body);
        } catch (Exception e) {
            String msg = "{\"error\":\"" + escape(String.valueOf(e.getMessage())) + "\"}";
            respond(out, 502, "application/json", msg.getBytes(StandardCharsets.UTF_8));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void handleStatic(OutputStream out, String path) throws IOException {
        String rel = path;
        if (rel.isEmpty() || "/".equals(rel)) rel = "/index.html";
        rel = URLDecoder.decode(rel, "UTF-8");
        while (rel.startsWith("/")) rel = rel.substring(1);
        if (rel.contains("..")) {
            respond(out, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8));
            return;
        }
        Path file = root.resolve(rel).normalize();
        if (!file.startsWith(root) || !file.toFile().isFile()) {
            respond(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
        String mime = MIME.getOrDefault(ext, "application/octet-stream");
        byte[] body;
        try (InputStream is = new FileInputStream(file.toFile())) {
            body = readAll(is);
        }
        respond(out, 200, mime, body);
    }

    /** 只监听 127.0.0.1，不需要 CORS 头；但加上也无害，方便以后调试 */
    private void respond(OutputStream out, int code, String contentType, byte[] body) throws IOException {
        String header = "HTTP/1.1 " + code + " " + reason(code) + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 429: return "Too Many Requests";
            default: return code >= 500 ? "Server Error" : "OK";
        }
    }

    private static boolean hostAllowed(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        for (String a : ALLOWED) {
            if (h.equals(a) || h.endsWith("." + a)) return true;
        }
        return false;
    }

    private static String param(String query, String key) {
        if (query == null || query.isEmpty()) return null;
        for (String kv : query.split("&")) {
            int eq = kv.indexOf('=');
            if (eq < 0) continue;
            if (!kv.substring(0, eq).equals(key)) continue;
            try {
                return URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 8192) break;
        }
        if (c == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}
