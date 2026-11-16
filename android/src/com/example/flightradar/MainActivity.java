package com.example.flightradar;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.os.Build;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Flight Radar App 的唯一界面：
 *   1. 把 assets/www 铺到私有目录（每次启动都重新铺，避免升级后用到旧网页）
 *   2. 起本地小服务（AssetServer），拿到 127.0.0.1 上的随机端口
 *   3. WebView 全屏加载 http://127.0.0.1:<port>/index.html
 *
 * 走 http://127.0.0.1 而不是 file:///android_asset 的原因：
 * file:// 下 fetch/XHR 全被同源策略拦死，canvas 也会被标成 tainted，
 * 而本地 http 源既是安全上下文（localStorage 等可用），也让 /api/fetch 代理能正常取数据。
 */
public class MainActivity extends Activity {

    private WebView web;
    private AssetServer server;

    /** 申请定位权限：拿到就用 GPS，没有就退回按 IP 定位 */
    private void askLocationPermission() {
        try {
            if (Build.VERSION.SDK_INT < 23) return;
            List<String> need = new ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            }
            if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        // 雷达要一直盯着看，别让屏幕自己灭
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enterFullscreen();
        askLocationPermission();

        File wwwDir = new File(getFilesDir(), "www");
        try {
            syncAssets(wwwDir);
        } catch (IOException e) {
            showError("资源解压失败：" + e.getMessage());
            return;
        }

        String url;
        try {
            server = new AssetServer(wwwDir.toPath());
            url = "http://127.0.0.1:" + server.getPort() + "/index.html";
        } catch (IOException e) {
            showError("本地服务启动失败：" + e.getMessage());
            return;
        }

        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUseWideViewPort(true);      // 让 index.html 的 viewport meta 生效
        s.setLoadWithOverviewMode(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // 触摸屏上不要长按弹出词典/选择菜单，雷达界面用不到
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            // 外链（比如点星跳转 GitHub）交给系统浏览器，页面内的本地地址继续留在 WebView
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req == null ? null : req.getUrl();
                if (u == null) return false;
                String host = u.getHost() == null ? "" : u.getHost();
                boolean local = "127.0.0.1".equals(host) || "localhost".equals(host);
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (local && ("http".equals(scheme) || "https".equals(scheme))) return false;
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                    return true;
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // 只有主文档失败才算致命，图片/接口失败交给页面自己提示
                if (req != null && req.isForMainFrame()) {
                    showError("页面加载失败：" + err.getDescription());
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // 网页里调用 getCurrentPosition 时，直接放行（定位只在本机使用）
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });

        setContentView(web);
        web.loadUrl(url);
    }

    /** 全屏沉浸：没有状态栏和导航栏，用户上滑可以临时唤出导航 */
    @SuppressWarnings("deprecation")
    private void enterFullscreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /** 出问题时至少给个能看清的提示，而不是一块黑屏 */
    private void showError(String msg) {
        TextView tv = new TextView(this);
        tv.setText(msg + "\n\n请截图反馈这一段文字。");
        tv.setTextColor(0xFF34FF8F);
        tv.setBackgroundColor(0xFF000000);
        tv.setTextSize(14);
        tv.setPadding(48, 120, 48, 48);
        setContentView(tv);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 单页应用，没有历史可退，直接退出
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        enterFullscreen();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * 把 assets/www 原样铺到 files/www。
     * 每次启动都重新铺一遍（4 个文件、约 70KB，几毫秒的事），
     * 这样 App 升级后绝不会出现"还在用旧网页"的怪问题。
     */
    private void syncAssets(File target) throws IOException {
        deleteTree(target);
        if (!target.mkdirs() && !target.isDirectory()) {
            throw new IOException("mkdirs failed: " + target);
        }
        for (String path : listAssets("www")) {
            copyAsset("www/" + path, new File(target, path));
        }
    }

    /** 递归列出 assets 下某个目录里的所有文件（相对路径） */
    private List<String> listAssets(String dir) throws IOException {
        List<String> out = new ArrayList<>();
        collect(dir, "", out);
        return out;
    }

    private void collect(String dir, String prefix, List<String> out) throws IOException {
        String[] names = getAssets().list(dir);
        if (names == null || names.length == 0) return;
        for (String name : names) {
            String full = dir + "/" + name;
            String rel = prefix.isEmpty() ? name : prefix + "/" + name;
            String[] sub = getAssets().list(full);
            if (sub != null && sub.length > 0) {
                collect(full, rel, out);
            } else {
                out.add(rel);
            }
        }
    }

    private void copyAsset(String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("mkdirs failed: " + parent);
        }
        try (InputStream in = getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
