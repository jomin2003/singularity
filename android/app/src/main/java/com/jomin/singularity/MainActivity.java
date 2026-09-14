package com.jomin.singularity;

import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final long BACK_EXIT_WINDOW_MS = 2000L;
    private long backPressedAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The screen must not dim or lock mid-run.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Draw behind the system bars (Android 15+ enforces edge-to-edge);
        // we then hide them so the game is genuinely fullscreen.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        getWindow().getDecorView().post(new Runnable() {
            @Override
            public void run() {
                hideSystemBars();
            }
        });

        // Require two presses before quitting so a stray back press during
        // play doesn't dump the player out of the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                long now = System.currentTimeMillis();
                if (now - backPressedAt < BACK_EXIT_WINDOW_MS) {
                    finish();
                } else {
                    backPressedAt = now;
                    Toast.makeText(MainActivity.this,
                            "Press back again to quit", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        }
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
                getWindow(), getWindow().getDecorView());
        if (controller == null) {
            return;
        }
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
