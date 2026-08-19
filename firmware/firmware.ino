/*
  =============================================================================
  PROYECTO: Monitor de Luz e Internet (ESP8266 -> Servidor Railway/Vercel)
  VERSIÓN: Portal Cautivo con Telegram Opcional + Notificación al Volver la Luz
  =============================================================================
*/

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>

const char* RAILWAY_SERVER_URL = "https://monitor-luz-vercel.vercel.app";
const char* TELEGRAM_BOT_TOKEN = "7864816301:AAH8rYp61u58jW4yvXn7V2Z3R8m0KqL1sP0"; 

#define EEPROM_SIZE 160
const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);

DNSServer dnsServer;
ESP8266WebServer webServer(80);

String ssid = "";
String password = "";
String telegramChatId = "";
String deviceId = "";

unsigned long lastPingTime = 0;
const unsigned long PING_INTERVAL = 60000;
bool configMode = false;

bool isValidSSID(String s) {
  if (s.length() == 0 || s.length() > 32) return false;
  for (unsigned int i = 0; i < s.length(); i++) {
    unsigned char c = (unsigned char)s[i];
    if (c < 32 || c > 126) return false;
  }
  return true;
}

void loadCredentials() {
  EEPROM.begin(EEPROM_SIZE);
  char ssidBuf[33] = {0};
  char passBuf[65] = {0};
  char tgBuf[33] = {0};

  for (int i = 0; i < 32; ++i) {
    byte b = EEPROM.read(i);
    ssidBuf[i] = (b >= 32 && b <= 126) ? char(b) : 0;
  }
  for (int i = 0; i < 64; ++i) {
    byte b = EEPROM.read(32 + i);
    passBuf[i] = (b >= 32 && b <= 126) ? char(b) : 0;
  }
  for (int i = 0; i < 32; ++i) {
    byte b = EEPROM.read(96 + i);
    tgBuf[i] = (b >= 32 && b <= 126) ? char(b) : 0;
  }

  ssid = String(ssidBuf);
  password = String(passBuf);
  telegramChatId = String(tgBuf);
  ssid.trim();
  password.trim();
  telegramChatId.trim();

  if (!isValidSSID(ssid)) {
    ssid = "";
    password = "";
  }
}

void saveCredentials(String qssid, String qpass, String qtg) {
  EEPROM.begin(EEPROM_SIZE);
  for (int i = 0; i < EEPROM_SIZE; ++i) EEPROM.write(i, 0);

  for (int i = 0; i < qssid.length(); ++i) EEPROM.write(i, qssid[i]);
  for (int i = 0; i < qpass.length(); ++i) EEPROM.write(32 + i, qpass[i]);
  for (int i = 0; i < qtg.length(); ++i) EEPROM.write(96 + i, qtg[i]);
  
  EEPROM.commit();
}

void sendTelegramNotification(String msg) {
  if (telegramChatId.length() == 0 || strlen(TELEGRAM_BOT_TOKEN) == 0) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String telegramUrl = "https://api.telegram.org/bot" + String(TELEGRAM_BOT_TOKEN) + "/sendMessage";

  if (http.begin(client, telegramUrl)) {
    http.addHeader("Content-Type", "application/json");
    String payload = "{\"chat_id\":\"" + telegramChatId + "\",\"text\":\"" + msg + "\",\"parse_mode\":\"HTML\"}";
    int httpCode = http.POST(payload);
    http.end();
  }
}

void handleRoot() {
  int n = WiFi.scanNetworks();
  
  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
                "<style>body{font-family:sans-serif;background:#0d1117;color:#fff;padding:16px;text-align:center}"
                ".card{background:#161b22;padding:20px;border-radius:16px;max-width:360px;margin:auto;border:1px solid #30363d}"
                ".net-item{background:#0d1117;border:1px solid #30363d;padding:10px 14px;border-radius:8px;margin:6px 0;text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:0.9rem}"
                ".net-item:hover{border-color:#58a6ff;background:#1f242c}"
                "input{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#fff;box-sizing:border-box;font-size:0.95rem}"
                "button{width:100%;padding:14px;background:#238636;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;font-size:1rem;margin-top:8px}</style>"
                "<script>function sel(s){document.getElementById('s').value=s;document.getElementById('p').focus();}</script>"
                "</head><body><div class='card'><h2>⚡ Configurar Luz</h2>"
                "<p style='color:#10b981;font-weight:bold;font-size:0.9rem;margin-bottom:8px'>ID Dispositivo: " + deviceId + "</p>"
                "<p style='color:#8b949e;font-size:0.85rem;text-align:left;margin-bottom:6px'>Toca tu red WiFi para seleccionarla:</p>"
                "<div style='max-height:130px;overflow-y:auto;margin-bottom:10px;'>";

  if (n <= 0) {
    html += "<p style='color:#8b949e'>Buscando redes cercanas...</p>";
  } else {
    for (int i = 0; i < n; ++i) {
      String netName = WiFi.SSID(i);
      int rssi = WiFi.RSSI(i);
      String signalStr = rssi > -65 ? "📶 Excelente" : (rssi > -80 ? "📶 Buena" : "📶 Débil");
      html += "<div class='net-item' onclick=\"sel('" + netName + "')\"><span>" + netName + "</span><small style='color:#8b949e'>" + signalStr + "</small></div>";
    }
  }

  html += "</div>"
          "<form action='/save' method='POST'>"
          "<input type='text' id='s' name='s' placeholder='Nombre del WiFi (SSID)' required><br>"
          "<input type='password' id='p' name='p' placeholder='Contraseña de tu WiFi' required><br>"
          "<input type='text' id='t' name='t' placeholder='Chat ID de Telegram (Opcional)' value='" + telegramChatId + "'><br>"
          "<button type='submit'>CONECTAR Y VALIDAR 🚀</button>"
          "</form></div></body></html>";

  webServer.send(200, "text/html", html);
}

void handleSave() {
  if (webServer.hasArg("s") && webServer.hasArg("p")) {
    String testSsid = webServer.arg("s");
    String testPass = webServer.arg("p");
    String testTg = webServer.hasArg("t") ? webServer.arg("t") : "";
    testSsid.trim();
    testPass.trim();
    testTg.trim();

    WiFi.begin(testSsid.c_str(), testPass.c_str());

    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
      delay(500);
      tries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      saveCredentials(testSsid, testPass, testTg);
      String myUrl = String(RAILWAY_SERVER_URL) + "/?id=" + deviceId;

      String successHtml = "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
                           "<style>body{font-family:sans-serif;background:#0d1117;color:#fff;padding:20px;text-align:center}"
                           ".card{background:#161b22;padding:24px;border-radius:16px;max-width:340px;margin:auto;border:1px solid #30363d}"
                           "input{width:100%;padding:12px;margin:12px 0;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#60a5fa;box-sizing:border-box;font-family:monospace;font-size:0.85rem;text-align:center}"
                           "button{width:100%;padding:14px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;font-size:1rem}</style>"
                           "<script>function copyUrl(){var copyText=document.getElementById('u');copyText.select();copyText.setSelectionRange(0,99999);navigator.clipboard.writeText(copyText.value);document.getElementById('b').textContent='¡COPIADO! ✅';}</script>"
                           "</head><body><div class='card'>"
                           "<h2 style='color:#10b981'>¡Clave Correcta! 🎉</h2>"
                           "<p style='color:#10b981;font-weight:bold;'>Dispositivo: " + deviceId + "</p>"
                           "<p style='color:#8b949e;font-size:0.85rem'>Este es tu enlace único de monitoreo. Toca el botón para copiarlo:</p>"
                           "<input type='text' id='u' value='" + myUrl + "' readonly>"
                           "<button id='b' onclick='copyUrl()'>📋 COPIAR ENLACE</button>"
                           "<p style='color:#e5c07b;font-size:0.8rem;margin-top:16px'>La placa ya está conectada y monitoreando.</p>"
                           "</div></body></html>";

      webServer.send(200, "text/html", successHtml);
      delay(4000);
      ESP.restart();
    } else {
      WiFi.disconnect();
      String errorHtml = "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
                         "<style>body{font-family:sans-serif;background:#0d1117;color:#fff;padding:20px;text-align:center}"
                         ".card{background:#161b22;padding:24px;border-radius:16px;max-width:340px;margin:auto;border:1px solid #ef4444}"
                         "a{display:block;width:100%;padding:14px;background:#ef4444;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-top:16px;box-sizing:border-box}</style></head><body>"
                         "<div class='card'>"
                         "<h2 style='color:#ef4444'>⚠️ Clave Incorrecta</h2>"
                         "<p style='color:#8b949e'>No se pudo conectar a la red '<b>" + testSsid + "</b>'. Verifica la contraseña e inténtalo de nuevo.</p>"
                         "<a href='/'>VOLVER A INTENTAR 🔄</a>"
                         "</div></body></html>";

      webServer.send(200, "text/html", errorHtml);
    }
  }
}

void startConfigPortal() {
  configMode = true;
  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP("Configurar-Luz");

  dnsServer.start(DNS_PORT, "*", apIP);

  webServer.on("/", handleRoot);
  webServer.on("/save", handleSave);
  webServer.onNotFound(handleRoot);
  webServer.begin();
}

void sendPingToRailway() {
  pinMode(LED_BUILTIN, OUTPUT);
  for (int i = 0; i < 10; i++) {
    digitalWrite(LED_BUILTIN, LOW);
    delay(250);
    digitalWrite(LED_BUILTIN, HIGH);
    delay(250);
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String endpoint = String(RAILWAY_SERVER_URL) + "/api/ping";

  if (http.begin(client, endpoint)) {
    http.addHeader("Content-Type", "application/json");
    String jsonPayload = "{\"deviceId\":\"" + deviceId + "\",\"uptimeMs\":" + String(millis()) + "}";
    int httpCode = http.POST(jsonPayload);

    if (httpCode > 0) {
      String response = http.getString();
      if (response.indexOf("RESET_WIFI") != -1) {
        saveCredentials("", "", "");
        for (int i = 0; i < 10; i++) {
          digitalWrite(LED_BUILTIN, LOW);
          delay(100);
          digitalWrite(LED_BUILTIN, HIGH);
          delay(100);
        }
        delay(1000);
        ESP.restart();
      }
    }
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  uint32_t chipId = ESP.getChipId();
  char idBuffer[16];
  snprintf(idBuffer, sizeof(idBuffer), "ESP-%06X", chipId);
  deviceId = String(idBuffer);

  EEPROM.begin(512);
  byte resetCounter = EEPROM.read(90);

  if (resetCounter >= 2) {
    EEPROM.write(90, 0);
    EEPROM.commit();
    saveCredentials("", "", "");
    startConfigPortal();
    return;
  } else {
    EEPROM.write(90, resetCounter + 1);
    EEPROM.commit();
  }

  loadCredentials();

  if (ssid.length() == 0 || !isValidSSID(ssid)) {
    startConfigPortal();
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), password.c_str());

    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 360) {
      delay(500);
      if (tries % 4 == 0) {
        digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
      }
      tries++;
    }

    digitalWrite(LED_BUILTIN, HIGH);

    if (WiFi.status() == WL_CONNECTED) {
      EEPROM.write(90, 0);
      EEPROM.commit();

      if (telegramChatId.length() > 0) {
        String alertMsg = "⚡ <b>¡VOLVIÓ LA LUZ!</b>\n"
                          "La energía eléctrica ha regresado a tu casa.\n\n"
                          "📱 <b>Dispositivo:</b> " + deviceId + "\n"
                          "🔗 <b>Monitor:</b> " + String(RAILWAY_SERVER_URL) + "/?id=" + deviceId;
        sendTelegramNotification(alertMsg);
      }

      sendPingToRailway();
    } else {
      startConfigPortal();
    }
  }
}

void loop() {
  static bool counterReset = false;
  if (!counterReset && millis() > 10000) {
    EEPROM.begin(512);
    EEPROM.write(90, 0);
    EEPROM.commit();
    counterReset = true;
  }

  if (configMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(5000);
    return;
  }

  if (millis() - lastPingTime >= PING_INTERVAL || lastPingTime == 0) {
    sendPingToRailway();
    lastPingTime = millis();
  }
}
