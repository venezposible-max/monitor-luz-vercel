/*
 * =========================================================================
 *  NETWATCH: AUDITOR DE CALIDAD Y ESTABILIDAD DE INTERNET 24/7 (ESP32)
 * =========================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <time.h>
#include "index_html.h"

#define LED_STATUS 2
#define BUTTON_BOOT 0

WebServer server(80);
DNSServer dnsServer;
Preferences preferences;

String sta_ssid = "";
String sta_pass = "";
bool isConfigured = false;
unsigned long bootButtonTimer = 0;

IPAddress apIP(192, 168, 4, 1);
IPAddress apNetMask(255, 255, 255, 0);

bool isInternetOnline = false;
int currentPingMs = 0;
int pingHistory[20];
int pingHistoryIndex = 0;

unsigned long systemStartTime = 0;
unsigned long totalOutageSeconds = 0;
unsigned long currentOutageStart = 0;
int totalOutagesCount = 0;

struct OutageEvent {
    int id;
    String startTime;
    String endTime;
    String duration;
};

const int MAX_OUTAGES = 25;
OutageEvent outageHistory[MAX_OUTAGES];
int totalStoredOutages = 0;

unsigned long lastPingCheck = 0;

// Cloudflare 1.1.1.1 en Puerto 80 (Universalmente abierto en todos los routers)
IPAddress pingTarget(1, 1, 1, 1);

// =========================================================================
//  MEDICION DE LATENCIA (RAPIDA Y NO BLOQUEANTE)
// =========================================================================
int measurePing() {
    if (WiFi.status() != WL_CONNECTED) return -1;

    WiFiClient client;
    client.setTimeout(1); // 1 segundo maximo
    unsigned long start = millis();
    
    // Puerto 80 a 1.1.1.1 responde en 20-50ms en cualquier conexion
    if (client.connect(pingTarget, 80, 400)) {
        unsigned long duration = millis() - start;
        client.stop();
        return (int)duration;
    }
    return -1;
}

String getFormattedTime() {
    time_t now;
    struct tm timeinfo;
    if (!getLocalTime(&timeinfo, 50)) {
        unsigned long s = millis() / 1000;
        char buf[20];
        snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", (s / 3600) % 24, (s / 60) % 60, s % 60);
        return String(buf);
    }
    char buf[30];
    strftime(buf, sizeof(buf), "%I:%M:%S %p", &timeinfo);
    return String(buf);
}

String buildConfigPage() {
    int n = WiFi.scanNetworks();
    String networks = "";
    for (int i = 0; i < n; ++i) {
        String s = WiFi.SSID(i);
        if (s.length() > 0) {
            int rssi = WiFi.RSSI(i);
            String q = (rssi > -60) ? "Fuerte" : ((rssi > -75) ? "Media" : "Debil");
            networks += "<option value=\"" + s + "\">" + s + " (" + q + ")</option>";
        }
    }

    String html = "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">";
    html += "<title>Configurar NetWatch</title>";
    html += "<style>body{background:#0b0f19;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:15px;}";
    html += ".card{background:#131b2e;border:1px solid #1e293b;border-radius:16px;width:100%;max-width:400px;padding:24px;}";
    html += "h1{color:#38bdf8;font-size:1.3rem;margin-bottom:8px;} p{color:#94a3b8;font-size:0.85rem;margin-bottom:16px;}";
    html += "label{display:block;font-size:0.75rem;color:#cbd5e1;margin-bottom:6px;margin-top:12px;text-transform:uppercase;font-weight:700;}";
    html += "select,input{width:100%;padding:12px;background:#0b0f19;border:1px solid #334155;border-radius:10px;color:#fff;font-size:0.95rem;}";
    html += "button{width:100%;padding:14px;background:#0284c7;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;margin-top:20px;cursor:pointer;}";
    html += "</style></head><body><div class=\"card\">";
    html += "<h1>Configurar NetWatch</h1><p>Conecta el auditor al WiFi de tu casa u oficina para iniciar el monitoreo 24/7.</p>";
    html += "<form action=\"/save\" method=\"POST\"><label>Red WiFi (Tu Proveedor)</label>";
    html += "<select name=\"sta_ssid\" required><option value=\"\" disabled selected>Selecciona tu WiFi...</option>" + networks + "</select>";
    html += "<label>Contrasena WiFi</label><input type=\"password\" name=\"sta_pass\" placeholder=\"Clave de tu red\" required>";
    html += "<button type=\"submit\">Iniciar Auditoria de Red</button></form></div></body></html>";
    return html;
}

void handleRoot() {
    if (!isConfigured || WiFi.status() != WL_CONNECTED) {
        server.send(200, "text/html", buildConfigPage());
    } else {
        server.send_P(200, "text/html", INDEX_HTML);
    }
}

void handleSave() {
    if (server.hasArg("sta_ssid") && server.hasArg("sta_pass")) {
        sta_ssid = server.arg("sta_ssid");
        sta_pass = server.arg("sta_pass");

        preferences.begin("netwatch", false);
        preferences.putString("sta_ssid", sta_ssid);
        preferences.putString("sta_pass", sta_pass);
        preferences.putBool("configured", true);
        preferences.end();

        server.send(200, "text/html", "<!DOCTYPE html><html><body style=\"background:#0b0f19;color:#10b981;font-family:sans-serif;text-align:center;padding:40px;\"><h1>Conectando al WiFi...</h1><p style=\"color:#fff;\">El auditor se reiniciara y empezara a medir tu red.</p></body></html>");
        delay(1500);
        ESP.restart();
    } else {
        server.send(400, "text/plain", "Faltan parametros");
    }
}

void handleReset() {
    preferences.begin("netwatch", false);
    preferences.clear();
    preferences.end();
    server.send(200, "text/plain", "Configuracion borrada. Reiniciando...");
    delay(1000);
    ESP.restart();
}

void handleApiStatus() {
    unsigned long totalElapsedSec = (millis() - systemStartTime) / 1000;
    if (totalElapsedSec == 0) totalElapsedSec = 1;

    float uptime = 100.0;
    if (totalElapsedSec > 0) {
        uptime = (float)(totalElapsedSec - totalOutageSeconds) / (float)totalElapsedSec * 100.0;
        if (uptime < 0) uptime = 0;
    }

    String outageDurationStr = "";
    if (totalOutageSeconds >= 60) {
        outageDurationStr = String(totalOutageSeconds / 60) + " min " + String(totalOutageSeconds % 60) + " seg";
    } else {
        outageDurationStr = String(totalOutageSeconds) + " seg";
    }

    String json = "{";
    json += "\"isOnline\":" + String(isInternetOnline ? "true" : "false") + ",";
    json += "\"currentPing\":" + String(currentPingMs) + ",";
    json += "\"uptimePercent\":" + String(uptime, 2) + ",";
    json += "\"totalOutages\":" + String(totalOutagesCount) + ",";
    json += "\"totalOutageDurationStr\":\"" + outageDurationStr + "\",";

    json += "\"pingHistory\":[";
    for (int i = 0; i < 20; i++) {
        json += String(pingHistory[i]);
        if (i < 19) json += ",";
    }
    json += "],";

    json += "\"outages\":[";
    for (int i = 0; i < totalStoredOutages; i++) {
        json += "{";
        json += "\"id\":" + String(outageHistory[i].id) + ",";
        json += "\"start\":\"" + outageHistory[i].startTime + "\",";
        json += "\"end\":\"" + outageHistory[i].endTime + "\",";
        json += "\"duration\":\"" + outageHistory[i].duration + "\"";
        json += "}";
        if (i < totalStoredOutages - 1) json += ",";
    }
    json += "]";
    json += "}";

    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

void setup() {
    Serial.begin(115200);
    pinMode(LED_STATUS, OUTPUT);
    pinMode(BUTTON_BOOT, INPUT_PULLUP);
    digitalWrite(LED_STATUS, LOW);

    delay(1000);
    Serial.println("\n========================================================");
    Serial.println("   NETWATCH: AUDITOR DE INTERNET 24/7 (ESP32)");
    Serial.println("========================================================");

    for (int i = 0; i < 20; i++) pingHistory[i] = 0;

    preferences.begin("netwatch", true);
    isConfigured = preferences.getBool("configured", false);
    sta_ssid = preferences.getString("sta_ssid", "");
    sta_pass = preferences.getString("sta_pass", "");
    preferences.end();

    if (isConfigured && sta_ssid.length() > 0) {
        Serial.print("[NETWATCH] Conectando a ");
        Serial.println(sta_ssid);

        WiFi.mode(WIFI_STA);
        WiFi.begin(sta_ssid.c_str(), sta_pass.c_str());

        int retries = 0;
        while (WiFi.status() != WL_CONNECTED && retries < 30) {
            delay(400);
            Serial.print(".");
            digitalWrite(LED_STATUS, !digitalRead(LED_STATUS));
            retries++;
        }

        if (WiFi.status() == WL_CONNECTED) {
            digitalWrite(LED_STATUS, HIGH);
            Serial.println("\n[NETWATCH] Conectado exitosamente al WiFi!");
            Serial.print("[NETWATCH] IP Local: http://");
            Serial.println(WiFi.localIP());

            configTime(-4 * 3600, 0, "pool.ntp.org", "time.google.com");

            if (MDNS.begin("netwatch")) {
                Serial.println("[NETWATCH] Disponible en: http://netwatch.local");
            }

            systemStartTime = millis();
        } else {
            Serial.println("\n[NETWATCH] Fallo al conectar. Iniciando Portal Cautivo...");
            isConfigured = false;
        }
    }

    if (!isConfigured || WiFi.status() != WL_CONNECTED) {
        WiFi.mode(WIFI_AP_STA);
        WiFi.softAPConfig(apIP, apIP, apNetMask);
        WiFi.softAP("Configurar-NetWatch", "");
        dnsServer.start(53, "*", apIP);
        Serial.println("[PORTAL] Conectate a: Configurar-NetWatch");
        Serial.println("[PORTAL] Abre en tu navegador: http://192.168.4.1");
    }

    server.on("/", handleRoot);
    server.on("/save", HTTP_POST, handleSave);
    server.on("/reset", handleReset);
    server.on("/api/status", handleApiStatus);
    server.onNotFound([]() {
        server.sendHeader("Location", "http://192.168.4.1/", true);
        server.send(302, "text/plain", "");
    });
    server.begin();
    Serial.println("[HTTP] Servidor Web Activo en puerto 80.");
}

void loop() {
    server.handleClient();

    if (!isConfigured || WiFi.status() != WL_CONNECTED) {
        dnsServer.processNextRequest();
    }

    unsigned long now = millis();
    if (isConfigured && WiFi.status() == WL_CONNECTED && (now - lastPingCheck >= 3000)) {
        lastPingCheck = now;

        int ping = measurePing();
        currentPingMs = ping;

        pingHistory[pingHistoryIndex] = ping > 0 ? ping : 0;
        pingHistoryIndex = (pingHistoryIndex + 1) % 20;

        if (ping > 0) {
            if (!isInternetOnline) {
                isInternetOnline = true;
                digitalWrite(LED_STATUS, HIGH);

                if (currentOutageStart > 0) {
                    unsigned long durationSec = (now - currentOutageStart) / 1000;
                    totalOutageSeconds += durationSec;

                    String durStr = "";
                    if (durationSec >= 60) {
                        durStr = String(durationSec / 60) + " min " + String(durationSec % 60) + " s";
                    } else {
                        durStr = String(durationSec) + " s";
                    }

                    if (totalStoredOutages < MAX_OUTAGES) {
                        outageHistory[totalStoredOutages].id = totalOutagesCount;
                        outageHistory[totalStoredOutages].startTime = getFormattedTime();
                        outageHistory[totalStoredOutages].endTime = getFormattedTime();
                        outageHistory[totalStoredOutages].duration = durStr;
                        totalStoredOutages++;
                    }

                    Serial.printf("\n[NETWATCH] INTERNET RESTABLECIDO. Corte duro: %s\n", durStr.c_str());
                    currentOutageStart = 0;
                }
            }
        } else {
            if (isInternetOnline) {
                isInternetOnline = false;
                digitalWrite(LED_STATUS, LOW);
                currentOutageStart = now;
                totalOutagesCount++;
                Serial.printf("\n[NETWATCH] ALERTA: CAIDA DE INTERNET DETECTADA a las %s\n", getFormattedTime().c_str());
            }
        }
    }

    if (digitalRead(BUTTON_BOOT) == LOW) {
        if (bootButtonTimer == 0) {
            bootButtonTimer = millis();
        } else if (millis() - bootButtonTimer >= 5000) {
            Serial.println("\n[RESET] Boton BOOT presionado por 5s. Borrando WiFi...");
            for (int i = 0; i < 5; i++) {
                digitalWrite(LED_STATUS, HIGH); delay(100);
                digitalWrite(LED_STATUS, LOW); delay(100);
            }
            preferences.begin("netwatch", false);
            preferences.clear();
            preferences.end();
            ESP.restart();
        }
    } else {
        bootButtonTimer = 0;
    }
}
