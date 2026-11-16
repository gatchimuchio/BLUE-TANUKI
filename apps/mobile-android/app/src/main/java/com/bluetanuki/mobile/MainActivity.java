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

import java.util.List;
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
    private Button newIdButton;
    private Button leaveButton;
    private Button localDeleteButton;
    private TextView recoveryAuditView;
    private String deviceId;
    private boolean identityReady;
    private boolean permissionRequestPending;
    private volatile boolean credentialStateUncertain;
    private boolean recoveryAuditUnavailable;
    private volatile boolean foreground;
    private volatile boolean busy;
    private volatile boolean pairingInFlight;
    private volatile boolean disconnectInFlight;
    private volatile boolean localDeleteInFlight;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        credentialStore = new AndroidCredentialStore(getApplicationContext());
        try {
            deviceId = credentialStore.loadOrCreateDeviceId();
            identityReady = true;
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            deviceId = null;
            identityReady = false;
        }
        setContentView(buildScreen());
        refreshCredentialControls(credentialStore.contains());
        refreshRecoveryAuditSummary();
        setStatus(identityReady
                ? "未接続です。保存済み端末IDをDesktop ownerへ安全な対面手段で渡し、対象端末向けの招待を発行してもらってください。"
                : "端末IDを安全に保存・再読込できません。招待登録を停止しています。");
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
        if (disconnectInFlight && statusView != null) {
            setStatus("解除通信中にアプリがbackgroundへ移りました。Desktop失効の結果は不明です。自動再送せず、Desktop側の端末状態を確認してください。");
        }
        if (localDeleteInFlight && statusView != null) {
            setStatus("端末内削除中にアプリがbackgroundへ移りました。復帰後に資格と回復記録を読み直して状態を確認します。");
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

        newIdButton = new Button(this);
        newIdButton.setText("未結合時に新しい端末IDを保存");
        newIdButton.setEnabled(identityReady && !credentialStore.contains());
        newIdButton.setOnClickListener(view -> {
            if (busy || !identityReady) return;
            try {
                deviceId = credentialStore.rotateDeviceId();
                updateDeviceId();
                clearPairingInputs();
                setStatus("新しい端末IDをこのアプリへ保存し、再読込を確認しました。古い招待は使わず、このID向けの招待を発行してください。");
            } catch (AndroidCredentialStore.CredentialStoreException exception) {
                identityReady = false;
                newIdButton.setEnabled(false);
                setStatus("端末IDを安全に保存・再読込できません。招待登録を停止しています。");
            }
        });
        content.addView(newIdButton, matchWrap());

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

        TextView linkRecoveryHeading = section("端末連携の解除と回復");
        content.addView(linkRecoveryHeading, matchWrap());
        TextView linkRecoveryHelp = new TextView(this);
        linkRecoveryHelp.setText("通常の解除はDesktopへ失効を要求し、正確な成功応答の後に端末内資格を削除します。通信できない場合の端末内削除は別操作です。端末内削除だけではDesktop側の資格は失効せず、実行中の仕事も停止しません。");
        linkRecoveryHelp.setTextSize(14);
        content.addView(linkRecoveryHelp, matchWrap());

        leaveButton = new Button(this);
        leaveButton.setText("Desktopで失効して、この端末の資格を削除");
        leaveButton.setOnClickListener(view -> beginDesktopRevocation());
        content.addView(leaveButton, matchWrap());

        localDeleteButton = new Button(this);
        localDeleteButton.setText("この端末から保存資格だけを削除");
        localDeleteButton.setOnClickListener(view -> beginLocalCredentialDelete());
        content.addView(localDeleteButton, matchWrap());

        recoveryAuditView = new TextView(this);
        recoveryAuditView.setTextSize(13);
        recoveryAuditView.setPadding(0, dp(6), 0, dp(4));
        content.addView(recoveryAuditView, matchWrap());

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
        if (!identityReady || deviceId == null) {
            setStatus("端末IDを安全に保存・再読込できないため、招待登録を停止しています。");
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
        refreshCredentialControls(false);
        setStatus("Desktopへ一回限りの結合要求を送信しています。画面を閉じると通信を停止します。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            AtomicBoolean stored = new AtomicBoolean(false);
            try {
                DeviceLinkTransport.Exchange exchange = transport.pair(invitation,
                        () -> canSend(operationGeneration));
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
                    refreshCredentialControls(stored.get() || credentialStore.contains());
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
        if (credentialStateUncertain) {
            refreshCredentialControls(credentialStore.contains());
            setStatus("保存資格または回復記録の状態を確定できません。通信・再結合を停止しています。アプリを再起動して状態を読み直してください。");
            return;
        }
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            credentialStateUncertain = true;
            refreshCredentialControls(true);
            setStatus("Keystore資格を読み取れません。保存済み資格を代用せず、Desktopへ接続しません。");
            return;
        }
        if (credential == null) {
            refreshCredentialControls(false);
            return;
        }
        refreshCredentialControls(true);
        if (credential.expiresAt <= System.currentTimeMillis() / 1000L) {
            setStatus("保存資格の有効期限が切れています。自動延長・再結合は行わず、Desktop ownerへ確認してください。");
            return;
        }
        if (!hasLocalNetworkPermission()) {
            setStatus("Desktop接続にはAndroidのローカルネットワーク許可が必要です。上の許可ボタンからOSへ要求してください。");
            return;
        }
        busy = true;
        refreshCredentialControls(true);
        setStatus("foregroundでKeystore資格を再読取し、Desktopへ端末確認を行っています。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            try {
                DeviceLinkTransport.Exchange exchange = transport.check(credential,
                        () -> canSend(operationGeneration));
                PairingResponseParser.requireConnectedResponse(exchange.response, exchange.nonce);
                postStatus(operationGeneration, "Desktop Brokerが端末確認を受理しました。これは現在の接続状態の観測であり、仕事の実行や承認を示しません。");
            } catch (PairingResponseParser.PairingRejectedException exception) {
                postStatus(operationGeneration, "Desktop Brokerが端末確認を拒否または停止しました。資格を使った仕事は行いません。");
            } catch (Exception exception) {
                postStatus(operationGeneration, "Desktop接続を確認できませんでした。不明状態を維持し、要求を自動再送しません。");
            } finally {
                mainHandler.post(() -> {
                    busy = false;
                    refreshCredentialControls(credentialStore.contains());
                    refreshRecoveryAuditSummary();
                });
            }
        });
    }

    private void beginDesktopRevocation() {
        if (!foreground || busy || credentialStateUncertain) return;
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            credentialStateUncertain = true;
            refreshCredentialControls(true);
            setStatus("保存資格を読めないためDesktop失効要求を停止しました。端末内資格を使いません。");
            return;
        }
        if (credential == null) {
            refreshCredentialControls(false);
            setStatus("端末内に保存資格がありません。Desktop側の端末状態は別途確認してください。");
            return;
        }
        if (credential.expiresAt <= System.currentTimeMillis() / 1000L) {
            setStatus("保存資格の期限が切れているため端末から失効要求を送れません。Desktop owner側で失効してください。");
            return;
        }
        if (!hasLocalNetworkPermission()) {
            requestLocalNetworkPermission();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Desktopとの端末結合を解除")
                .setMessage("Desktop Brokerへ端末離脱を一度だけ要求します。解除応答を確認した後に端末内資格を削除します。通信中断時はDesktop側の失効状態が不明になり、実行中または送信済みの仕事の停止は保証されません。")
                .setNegativeButton("キャンセル", (dialog, which) -> {})
                .setPositiveButton("Desktopへ失効を要求", (dialog, which) -> performDesktopRevocation(credential))
                .show();
    }

    private void performDesktopRevocation(DeviceCredential selected) {
        if (!foreground || busy || credentialStateUncertain || !hasLocalNetworkPermission()) return;
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            credentialStateUncertain = true;
            refreshCredentialControls(true);
            setStatus("保存資格を再読込できないため、Desktop失効要求を送信しませんでした。");
            return;
        }
        if (credential == null || !selected.sameValue(credential)) {
            refreshCredentialControls(credential != null);
            setStatus("確認画面を開いた後に保存資格が変わりました。失効要求を止めました。状態を再確認してください。");
            return;
        }
        busy = true;
        disconnectInFlight = true;
        refreshCredentialControls(true);
        setStatus("Desktopへ端末離脱を送信しています。応答不明時は自動再送しません。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            try {
                DeviceLinkTransport.Exchange exchange = transport.leave(credential,
                        () -> canSend(operationGeneration));
                PairingResponseParser.requireDisconnectedResponse(exchange.response, exchange.nonce);
                credentialStore.clearRevokedCredential();
                postStatus(operationGeneration,
                        "Desktopの失効応答と端末内資格の削除後readbackを確認しました。実行中・送信済みの仕事の停止は保証されません。");
            } catch (PairingResponseParser.PairingRejectedException exception) {
                postStatus(operationGeneration,
                        "Desktopが端末離脱を拒否または停止しました。保存資格は保持しています。Desktop ownerへ確認してください。");
            } catch (PairingResponseParser.PairingUnknownException exception) {
                postStatus(operationGeneration,
                        "Desktop応答を失効成功と確認できませんでした。資格を保持し、自動再送しません。Desktop側で状態を確認してください。");
            } catch (DeviceLinkTransport.TransportException exception) {
                if (exception.requestMayHaveReachedDesktop) {
                    postStatus(operationGeneration,
                            "失効要求の結果が不明です。資格を保持し、自動再送しません。Desktop ownerへ失効状態を確認してください。");
                } else {
                    postStatus(operationGeneration,
                            "失効要求は送信前に停止しました。資格は保持しています。接続を確認してから手動で再操作してください。");
                }
            } catch (AndroidCredentialStore.CredentialStoreException exception) {
                credentialStateUncertain = true;
                postStatus(operationGeneration,
                        "Desktopの失効応答は確認しましたが、端末内資格の削除後readbackを確認できません。失効を再送せず、端末内状態を再確認してください。");
            } finally {
                mainHandler.post(() -> {
                    busy = false;
                    disconnectInFlight = false;
                    if (foreground && generation.get() == operationGeneration) {
                        refreshCredentialControls(credentialStore.contains());
                        refreshRecoveryAuditSummary();
                    } else if (foreground) {
                        verifyStoredCredential();
                    }
                });
            }
        });
    }

    private void beginLocalCredentialDelete() {
        if (!foreground || busy || credentialStateUncertain || recoveryAuditUnavailable) return;
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            credentialStateUncertain = true;
            refreshCredentialControls(true);
            setStatus("保存資格を読めないため端末内削除を停止しました。");
            return;
        }
        if (credential == null) {
            refreshCredentialControls(false);
            setStatus("端末内に保存資格がありません。削除記録は追加していません。");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("端末内資格だけを削除")
                .setMessage("この操作は端末内の保存資格だけを削除し、Desktop側の結合を失効させません。実行中・送信済みの仕事も停止しません。Desktop ownerに失効を確認するか、失効未確認のまま進める必要がある場合だけ実行してください。非権威の端末内回復記録を同じ保護領域へ保存します。")
                .setNegativeButton("キャンセル", (dialog, which) -> {})
                .setPositiveButton("端末内だけ削除", (dialog, which) -> performLocalCredentialDelete(credential))
                .show();
    }

    private void performLocalCredentialDelete(DeviceCredential selected) {
        if (!foreground || busy || credentialStateUncertain || recoveryAuditUnavailable) return;
        final DeviceCredential credential;
        try {
            credential = credentialStore.read();
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            credentialStateUncertain = true;
            refreshCredentialControls(true);
            setStatus("保存資格を再読込できないため端末内削除を停止しました。");
            return;
        }
        if (credential == null || !selected.sameValue(credential)) {
            refreshCredentialControls(credential != null);
            setStatus("確認画面を開いた後に保存資格が変わりました。端末内削除を止めました。");
            return;
        }
        busy = true;
        localDeleteInFlight = true;
        refreshCredentialControls(true);
        setStatus("端末内資格の削除と回復記録を同じ保護領域へ保存しています。");
        long operationGeneration = generation.get();
        worker.execute(() -> {
            try {
                DeviceLinkLocalRecoveryAudit.Event event = credentialStore.deleteCredentialLocally();
                if (event == null) throw new AndroidCredentialStore.CredentialStoreException();
                postStatus(operationGeneration,
                        "端末内資格の不在と非権威の回復記録を再読込で確認しました。Desktop側の失効は未確認です。");
            } catch (AndroidCredentialStore.CredentialStoreException exception) {
                credentialStateUncertain = true;
                postStatus(operationGeneration,
                        "端末内資格または回復記録の削除状態を確認できません。通信・再結合を停止しました。アプリを再起動して状態を読み直してください。");
            } finally {
                mainHandler.post(() -> {
                    busy = false;
                    localDeleteInFlight = false;
                    refreshCredentialControls(credentialStore.contains());
                    refreshRecoveryAuditSummary();
                });
            }
        });
    }

    private boolean canSend(long operationGeneration) {
        return foreground && generation.get() == operationGeneration && !isFinishing() && !isDestroyed();
    }

    private void refreshCredentialControls(boolean credentialPresent) {
        if (pairButton == null) return;
        boolean usableCredential = credentialPresent;
        if (usableCredential) {
            try {
                DeviceCredential current = credentialStore.read();
                usableCredential = current != null &&
                        current.expiresAt > System.currentTimeMillis() / 1000L;
            } catch (AndroidCredentialStore.CredentialStoreException exception) {
                credentialStateUncertain = true;
                usableCredential = false;
            }
        }
        boolean ready = foreground && !busy && !credentialStateUncertain;
        pairButton.setEnabled(ready && !credentialPresent);
        newIdButton.setEnabled(identityReady && ready && !credentialPresent);
        if (leaveButton != null) {
            leaveButton.setEnabled(ready && usableCredential && hasLocalNetworkPermission());
        }
        if (localDeleteButton != null) {
            localDeleteButton.setEnabled(ready && credentialPresent && !recoveryAuditUnavailable);
        }
    }

    private void refreshRecoveryAuditSummary() {
        if (recoveryAuditView == null) return;
        try {
            List<DeviceLinkLocalRecoveryAudit.Event> events = credentialStore.readLocalRecoveryAudit();
            recoveryAuditUnavailable = false;
            recoveryAuditView.setText("端末内回復記録: " + events.size() + "件（内部状態のみ。Desktopの監査・失効を証明しません）");
        } catch (AndroidCredentialStore.CredentialStoreException exception) {
            recoveryAuditUnavailable = true;
            recoveryAuditView.setText("端末内回復記録を確認できません。端末内資格のみの削除を停止しています。");
            refreshCredentialControls(credentialStore.contains());
        }
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
            deviceIdView.setText(deviceId == null ? "端末IDを利用できません" : deviceId);
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
