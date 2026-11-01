package ca.matthewmenard.assistant;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

/**
 * The Android app is a thin native shell (Capacitor) around the shared web app.
 * This class adds two native entry points:
 *  - Share sheet: text shared from another app opens the "Draft from shared text" screen.
 *  - App shortcut "Drafts waiting": opens the inbox filtered to drafted emails.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String js = null;
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text == null) text = "";
            js = "location.hash = '#/share?text=' + encodeURIComponent(" + JSONObject.quote(text) + ") + '&title=' + encodeURIComponent(" + JSONObject.quote(subject == null ? "" : subject) + ");";
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri data = intent.getData();
            if ("assistant".equals(data.getScheme())) {
                String fragment = data.getFragment();
                js = "location.hash = " + JSONObject.quote(fragment == null ? "#/inbox" : "#" + fragment) + ";";
            }
        }
        if (js != null && getBridge() != null) {
            final String script = js;
            getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(script, null), 600);
        }
    }
}
