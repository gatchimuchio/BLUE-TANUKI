package com.bluetanuki.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public final class MainActivity extends Activity {
    private static final int REQUEST_LOCAL_NETWORK_PERMISSION = 3701;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final DeviceLinkTransport transport = new DeviceLinkTransport();

    private AndroidCredentialStore credentialStore;
    private TextView statusView;
    private TextView deviceIdView;
    private EditText hostInput;
    private EditText portInput;
    private EditText hostIdInput;
    private EditText fingerprintInput;
    private EditText invitationDeviceIdInput;
    private EditText expiryInput;
    private EditText invitationIdInput;
    private EditText invitationSecretInput;
    private CheckBox confirmation;
    private Button pairButton;
    private String deviceId;
    private boolean permissionRequestPending;
    private volatile boolean foreground;
    private volatile boolean busy;
    private volatile boolean pairingInFlight;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        credentialStore = new AndroidCredentialStore(getApplicationContext());
        deviceId = DeviceInvitation.newDeviceId();
        setContentView(buildScreen());
        setStatus("未接続です。端末IDをDesktop ownerへ安全な対面手段で渡し、対象端末向けの招待を発行してもらってください。");
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        verifyStoredCredential();
    }

    @Override
    protected void onStop() {
        foreground = false;
        generation.incrementAndGet();
        if (pairingInFlight && statusView != null) {
            setStatus("結合中にアプリがbackgroundへ移りました。Desktop結果を確認するまで不明状態とし、招待を再利用しないでください。");
        }
        transport.closeActive();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        foreground = false;
        transport.closeActive();
        worker.shutdownNow();
        super.onDestroy();
    }

    private ScrollView buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int outer = dp(20);
        content.setPadding(outer, dp(24), outer, dp(36));
        scroll.addView(content);

        TextView title = new TextView(this);
        title.setText("BLUE-TANUKI");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        content.addView(title, matchWrap());

        TextView subtitle = new TextView(this);
        subtitle.setText("Desktop Device Link");
        subtitle.setTextSize(16);
        subtitle.setPadding(0, dp(4), 0, dp(20));
        content.addView(subtitle, matchWrap());

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setPadding(dp(12), dp(12), dp(12), dp(12));
        statusView.setBackgroundColor(0xffeaf2f8);
        content.addView(statusView, matchWrap());

        TextView networkPermissionHelp = new TextView(this);
        networkPermissionHelp.setText("Android 17以降では、Desktop BrokerへのLAN接続にOSのローカルネットワーク許可が必要です。許可しても、アプリは入力されたprivate IPv4と証明書hashにだけ接続します。");
        networkPermissionHelp.setTextSize(14);
        networkPermissionHelp.setPadding(0, dp(12), 0, dp(4));
        content.addView(networkPermissionHelp, matchWrap());

        Button networkPermissionButton = new Button(this);
        networkPermissionButton.setText("Desktop接続のローカルネットワーク許可");
        networkPermissionButton.setOnClickListener(view -> requestLocalNetworkPermission());
        content.addView(networkPermissionButton, matchWrap());

        TextView idHeading = section("端末登録");
        content.addView(idHeading, matchWrap());
        TextView idHelp = new TextView(this);
        idHelp.setText("この端末IDをDesktop ownerへ渡して、期限付き招待を発行してもらいます。端末IDは秘密ではありません。");
        idHelp.setTextSize(14);
        content.addView(idHelp, matchWrap());
        deviceIdView = new TextView(this);
        deviceIdView.setTypeface(Typeface.MONOSPACE);
        deviceIdView.setTextSize(14);
        deviceIdView.setPadding(0, dp(8), 0, dp(8));
        content.addView(deviceIdView, matchWrap());
        updateDeviceId();

        Button newId = new Button(this);
        newId.setText("新しい端末IDを生成");
        newId.setOnClickListener(view -> {
            deviceId = DeviceInvitation.newDeviceId();
            updateDeviceId();
            clearPairingInputs();
            setStatus("新しい端末IDを生成しました。これに対する新しいDesktop招待を発行してください。");
        });
        content.addView(newId, matchWrap());

        TextView pairingHeading = section("一回限りのDesktop招待");
        content.addView(pairingHeading, matchWrap());
        TextView pairingHelp = new TextView(this);
        pairingHelp.setText("招待情報はこの端末の画面内だけで入力します。正確なHostと証明書hashをDesktop ownerと対面確認してください。接続はprivate IPv4とTLSに限定されます。");
        pairingHelp.setTextSize(14);
        content.addView(pairingHelp, matchWrap());

        hostInput = addInput(content, "Desktop private IPv4", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, false);
        portInput = addInput(content, "TLS port", InputType.TYPE_CLASS_NUMBER, false);
        hostIdInput = addInput(content, "HostID", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, false);
        fingerprintInput = addInput(content, "TLS certificate SHA-256", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, false);
        invitationDeviceIdInput = addInput(content, "招待端末ID", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, false);
        expiryInput = addInput(content, "招待の有効期限（Unix秒）", InputType.TYPE_CLASS_NUMBER, false);
        invitationIdInput = addInput(content, "招待ID", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, false);
        invitationSecretInput = addInput(content, "招待秘密", InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, true);

        confirmation = new CheckBox(this);
        confirmation.setText("Desktop ownerと対面で照合し、上のHostと証明書hashが招待の値と一致することを確認しました。");
        confirmation.setTextSize(14);
        confirmation.setPadding(0, dp(12), 0, dp(12));
        content.addView(confirmation, matchWrap());

        pairButton = new Button(this);
        pairButton.setText("この端末をDesktopへ一度だけ結合");
        pairButton.setOnClickListener(view -> beginPairing());
        content.addView(pairButton, matchWrap());

        TextView boundary = new TextView(this);
        boundary.setText("MobileはOwner承認、権限、実行判断を作りません。Desktop BrokerがDevice Link資格、監査、許可操作を判定します。結果不明の要求は自動再送しません。");
        boundary.setTextSize(13);
        boundary.setPadding(0, dp(20), 0, 0);
        content.addView(boundary, matchWrap());

        return scroll;
    }

    private void beginPairing() {
        if (busy || !foreground) {
            return;
        }
        if (!confirmation.isChecked()) {
            setStatus("接続先確認が必要です。Desktop ownerとHost・証明書hashを照合してください。");
            return;
        }
        final DeviceInvitation invitation;
        try {
            invitation = DeviceInvitation.create(
                    text(hostInput), text(portInput), text(hostIdInput), text(fingerprintInput),
                    text(invitationDeviceIdInput), deviceId, text(expiryInput), text(invitationIdInput),
                    text(invitationSecretInput), System.currentTimeMillis() / 1000L);
        } catch (DeviceInvitation.InvitationException exception) {
            setStatus(exception.getMessage());
            return;
        }
        if (credentialStore.contains()) {
            setStatus("端末資格が保存されています。新しい結合を始める前に、Desktop側で既存結合を失効してください。");
            return;
        }
        if (!hasLocalNetworkPermission()) {
            requestLocalNetworkPermission();
            return;
        }

        invitationSecretInput.setText("");
        confirmation.setChecked(false);
        busy = true;
        pairingInFlight = true;
        pairButton.setEnabled(false);
        setStatus("Desktopへ一回限りの結合要求を送信しています。画面を閉じると通信を停止します。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            AtomicBoolean stored = new AtomicBoolean(false);
            try {
                DeviceLinkTransport.Exchange exchange = transport.pair(invitation);
                DeviceCredential credential = PairingResponseParser.parse(exchange.response, invitation,
                        exchange.nonce, System.currentTimeMillis() / 1000L);
                credentialStore.saveAndVerify(credential);
                stored.set(true);
                postStatus(operationGeneration, "端末結合とKeystore保管のreadbackを確認しました。");
            } catch (PairingResponseParser.PairingRejectedException exception) {
                postStatus(operationGeneration, "Desktop Brokerが結合を拒否または停止しました。自由文理由は表示せず、Desktop状態を確認してください。");
            } catch (PairingResponseParser.PairingUnknownException exception) {
                postStatus(operationGeneration, "結合結果が不明です。招待を再利用しないでください。Desktop ownerに既存結合を確認してもらい、必要なら失効後に新しい招待を発行してください。");
            } catch (DeviceLinkTransport.TransportException exception) {
                if (exception.requestMayHaveReachedDesktop) {
                    postStatus(operationGeneration, "結合結果が不明です。招待を再利用しないでください。Desktop ownerに既存結合を確認してもらい、必要なら失効後に新しい招待を発行してください。");
                } else {
                    postStatus(operationGeneration, "結合要求は送信前に停止しました。Desktop接続と招待を確認してください。招待秘密は画面から消去済みなので再入力が必要です。");
                }
            } catch (AndroidCredentialStore.CredentialStoreException exception) {
                postStatus(operationGeneration, "Desktopが結合を受理した可能性がありますが、Keystore保存とreadbackを確認できませんでした。結合完了とは表示しません。招待を再利用せず、Desktop ownerに失効と再発行を依頼してください。");
            } finally {
                mainHandler.post(() -> {
                    busy = false;
                    pairingInFlight = false;
                    pairButton.setEnabled(foreground);
                    clearPairingInputs();
                    if (stored.get()) verifyStoredCredential();
                });
            }
        });
    }

    private void verifyStoredCredential() {
        if (!foreground || busy) {
            return;
        }
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            setStatus("Keystore資格を読み取れません。保存済み資格を代用せず、Desktopへ接続しません。");
            return;
        }
        if (credential == null) {
            return;
        }
        if (credential.expiresAt <= System.currentTimeMillis() / 1000L) {
            setStatus("保存資格の有効期限が切れています。自動延長・再結合は行わず、Desktop ownerへ確認してください。");
            return;
        }
        if (!hasLocalNetworkPermission()) {
            setStatus("Desktop接続にはAndroidのローカルネットワーク許可が必要です。上の許可ボタンからOSへ要求してください。");
            return;
        }
        busy = true;
        pairButton.setEnabled(false);
        setStatus("foregroundでKeystore資格を再読取し、Desktopへ端末確認を行っています。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            try {
                DeviceLinkTransport.Exchange exchange = transport.check(credential);
                PairingResponseParser.requireConnectedResponse(exchange.response, exchange.nonce);
                postStatus(operationGeneration, "Desktop Brokerが端末確認を受理しました。これは現在の接続状態の観測であり、仕事の実行や承認を示しません。");
            } catch (PairingResponseParser.PairingRejectedException exception) {
                postStatus(operationGeneration, "Desktop Brokerが端末確認を拒否または停止しました。資格を使った仕事は行いません。");
            } catch (Exception exception) {
                postStatus(operationGeneration, "Desktop接続を確認できませんでした。不明状態を維持し、要求を自動再送しません。");
            } finally {
                mainHandler.post(() -> {
                    busy = false;
                    pairButton.setEnabled(foreground);
                });
            }
        });
    }

    private void postStatus(long operationGeneration, String message) {
        mainHandler.post(() -> {
            if (foreground && generation.get() == operationGeneration) {
                setStatus(message);
            }
        });
    }

    private boolean hasLocalNetworkPermission() {
        return Build.VERSION.SDK_INT < 37 ||
                checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) ==
                        PackageManager.PERMISSION_GRANTED;
    }

    private void requestLocalNetworkPermission() {
        if (!foreground || permissionRequestPending) {
            return;
        }
        if (Build.VERSION.SDK_INT < 37 || hasLocalNetworkPermission()) {
            if (credentialStore.contains()) {
                verifyStoredCredential();
            } else if (Build.VERSION.SDK_INT < 37) {
                setStatus("このAndroidでは専用のローカルネットワーク許可は必要ありません。Desktop招待を入力して一度限りの結合を行ってください。");
            } else {
                setStatus("ローカルネットワーク許可を確認しました。Desktop招待を入力して一度限りの結合を行ってください。");
            }
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Desktopへのローカル接続を許可")
                .setMessage("BLUE-TANUKIは、ここで入力したprivate IPv4のDesktop BrokerとTLS接続するためにAndroid 17のローカルネットワーク許可を使います。許可後も、招待のHostと証明書hashを照合してから接続します。")
                .setNegativeButton("許可しない", (dialog, which) ->
                        setStatus("ローカルネットワーク許可は要求していません。許可するまでDesktopへ接続しません。"))
                .setPositiveButton("OSに許可を求める", (dialog, which) -> {
                    permissionRequestPending = true;
                    requestPermissions(new String[] { Manifest.permission.ACCESS_LOCAL_NETWORK },
                            REQUEST_LOCAL_NETWORK_PERMISSION);
                })
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                          int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_LOCAL_NETWORK_PERMISSION) {
            return;
        }
        permissionRequestPending = false;
        if (hasLocalNetworkPermission()) {
            setStatus("ローカルネットワーク許可を確認しました。Desktop招待の入力後、結合ボタンをもう一度押してください。");
            if (credentialStore.contains()) {
                verifyStoredCredential();
            }
        } else {
            setStatus("ローカルネットワーク許可がありません。許可するまでDesktopとの通信は行いません。必要なら設定で許可してください。");
        }
    }

    private void clearPairingInputs() {
        if (hostInput == null) return;
        hostInput.setText("");
        portInput.setText("");
        hostIdInput.setText("");
        fingerprintInput.setText("");
        invitationDeviceIdInput.setText("");
        expiryInput.setText("");
        invitationIdInput.setText("");
        invitationSecretInput.setText("");
        confirmation.setChecked(false);
    }

    private void updateDeviceId() {
        if (deviceIdView != null) {
            deviceIdView.setText(deviceId);
        }
    }

    private EditText addInput(LinearLayout parent, String label, int inputType, boolean secret) {
        TextView heading = new TextView(this);
        heading.setText(label);
        heading.setTextSize(14);
        heading.setPadding(0, dp(12), 0, dp(4));
        parent.addView(heading, matchWrap());
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setTextSize(15);
        input.setInputType(inputType);
        input.setSaveEnabled(false);
        input.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO);
        if (secret) {
            input.setLongClickable(false);
            input.setTextIsSelectable(false);
        }
        parent.addView(input, matchWrap());
        return input;
    }

    private TextView section(String label) {
        TextView heading = new TextView(this);
        heading.setText(label);
        heading.setTextSize(18);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setPadding(0, dp(24), 0, dp(8));
        return heading;
    }

    private void setStatus(String value) {
        if (statusView != null) {
            statusView.setText(value);
        }
    }

    private String text(EditText input) {
        return input.getText().toString().trim();
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
