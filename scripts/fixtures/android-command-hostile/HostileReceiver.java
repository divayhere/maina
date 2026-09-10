package com.divay.maina.hostile;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** A differently signed emulator-only probe for Maina's broadcast boundary. */
public final class HostileReceiver extends BroadcastReceiver {
  private static final String TARGET = "com.divay.maina";

  @Override
  public void onReceive(Context context, Intent trigger) {
    String mode = trigger.getStringExtra("mode");
    if (mode == null) {
      write(context, "invalid_mode");
      return;
    }
    Intent attack = buildAttack(mode);
    if (attack == null) {
      write(context, "invalid_mode");
      return;
    }
    if ("shell_explicit".equals(mode)) {
      BroadcastReceiver.PendingResult pending = goAsync();
      try {
        context.sendOrderedBroadcast(
            attack,
            null,
            new BroadcastReceiver() {
              @Override
              public void onReceive(Context ignored, Intent resultIntent) {
                write(context, "ordered_result_" + getResultCode());
                pending.finish();
              }
            },
            null,
            0,
            null,
            null);
      } catch (SecurityException denied) {
        write(context, "security_exception");
        pending.finish();
      }
      return;
    }
    try {
      context.sendBroadcast(attack);
      write(context, "sent");
    } catch (SecurityException denied) {
      write(context, "security_exception");
    }
  }

  private static Intent buildAttack(String mode) {
    if ("static_explicit".equals(mode)) {
      return new Intent("com.divay.maina.action.START")
          .setComponent(new ComponentName(TARGET, "com.divay.maina.recorder.MainaCommandReceiver"));
    }
    if ("static_package".equals(mode)) {
      return new Intent("com.divay.maina.action.START").setPackage(TARGET);
    }
    if ("dynamic_exact".equals(mode)) {
      return new Intent("com.divay.maina.recorder.HARDWARE_TRIGGER")
          .setPackage(TARGET)
          .putExtra("command", "start")
          .putExtra("commandId", "hostile-command-id")
          .putExtra("source", "hostile-app")
          .putExtra("keyCode", -1)
          .putExtra("deviceId", -1)
          .putExtra("deviceName", "hostile-probe")
          .putExtra("occurredAt", 1L);
    }
    if ("shell_explicit".equals(mode)) {
      return new Intent("com.divay.maina.recorder.SHELL_COMMAND")
          .setComponent(new ComponentName(TARGET, "com.divay.maina.recorder.MainaShellCommandReceiver"))
          .putExtra("command", "start")
          .putExtra("expectedState", "idle")
          .putExtra("nonce", "HostileNonce0001");
    }
    return null;
  }

  private static void write(Context context, String value) {
    File target = new File(context.getFilesDir(), "result.txt");
    try (FileOutputStream output = new FileOutputStream(target, false)) {
      output.write(value.getBytes(StandardCharsets.US_ASCII));
      output.getFD().sync();
    } catch (Exception ignored) {
      // Absence is itself a fail-closed result for the external verifier.
    }
  }
}
