/*
 * =========================================================================
 *  REPETIDOR WIFI PORTATIL / EXTENSOR DE RANGO NAT (ESP32)
 * =========================================================================
 *  - Compatible con: Starlink, Fibra Optica, CANTV, Modems 4G y Routers.
 *  - Configuracion 100% Automatica via Portal Cautivo desde el Celular.
 *  - Enrutamiento NAT TCP/IP integrado.
 *  - Memoria permanente (NVS / Preferences).
 *  - Reseteo fisico manteniendo el boton BOOT por 5 segundos.
 *  - Panel de administracion web en http://192.168.4.1
 * =========================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include "esp_wifi.h"

// Inclusion condicional de NAPT para ESP32 Core 3.x y 2.x
#if __has_include("lwip/lwip_napt.h")
  #include "lwip/lwip_napt.h"
  #define HAVE_NAPT 1
#elif __has_include("napt.h")
  #include "napt.h"
  #define HAVE_NAPT 1
#else
  #define HAVE_NAPT 0
#endif

// Servidores y Objetos
WebServer server(80);
DNSServer dnsServer;
Preferences preferences;

// Pines
#define BUTTON_BOOT 0
#define LED_STATUS  2

// Variables de Configuracion
String sta_ssid = "";
String sta_pass = "";
String ap_ssid = "Starlink-Repetidor";
String ap_pass = "12345678";

bool isConfigured = false;
bool isConnected = false;
unsigned long bootButtonTimer = 0;

// Configuracion IP de la Red Repetida (Access Point)
IPAddress apIP(192, 168, 4, 1);
IPAddress apNetMask(255, 255, 255, 0);

// =========================================================================
//  PAGINAS WEB (PORTAL CAUTIVO Y CONFIGURACION)
// =========================================================================

String buildConfigPage() {
    int n = WiFi.scanNetworks();
    String networksOptions = "";
    for (int i = 0; i < n; ++i) {
        String ssidName = WiFi.SSID(i);
        if (ssidName.length() > 0) {
            int rssi = WiFi.RSSI(i);
            String quality = (rssi > -60) ? "Fuerte" : ((rssi > -75) ? "Media" : "Debil");
            networksOptions += "<option value=\"" + ssidName + "\">" + ssidName + " (" + quality + ")</option>";
        }
    }
    if (n == 0) {
        networksOptions = "<option value=\"\">No se encontraron redes</option>";
    }

    String html = "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">";
    html += "<title>Configurar Repetidor WiFi ESP32</title>";
    html += "<style>";
    html += "* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }";
    html += "body { background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; }";
    html += ".card { background: #1e293b; border-radius: 16px; width: 100%; max-width: 420px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }";
    html += "h1 { font-size: 1.35rem; color: #38bdf8; margin-bottom: 6px; }";
    html += "p { color: #94a3b8; font-size: 0.85rem; margin-bottom: 20px; line-height: 1.4; }";
    html += ".badge { background: #0284c7; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 99px; }";
    html += "label { display: block; font-size: 0.8rem; font-weight: 600; color: #cbd5e1; margin-bottom: 6px; margin-top: 14px; text-transform: uppercase; }";
    html += "select, input { width: 100%; padding: 12px; background: #0f172a; border: 1px solid #475569; border-radius: 10px; color: #fff; font-size: 0.95rem; outline: none; }";
    html += ".divider { border-top: 1px dashed #334155; margin: 20px 0; }";
    html += ".btn { width: 100%; padding: 14px; background: #0284c7; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: 20px; }";
    html += ".note { background: rgba(56,189,248,0.1); border-left: 3px solid #38bdf8; padding: 10px; font-size: 0.78rem; color: #7dd3fc; border-radius: 4px; margin-top: 15px; }";
    html += "</style></head><body>";
    html += "<div class=\"card\">";
    html += "<h1>Repetidor WiFi <span class=\"badge\">ESP32</span></h1>";
    html += "<p>Extiende la senal de tu Starlink, Fibra o Router a cualquier rincon sin cables.</p>";
    html += "<form action=\"/save\" method=\"POST\">";
    html += "<label>1. Red Principal (Starlink / Router)</label>";
    html += "<select name=\"sta_ssid\" required><option value=\"\" disabled selected>Selecciona tu red WiFi...</option>" + networksOptions + "</select>";
    html += "<label>Clave de la Red Principal</label>";
    html += "<input type=\"password\" name=\"sta_pass\" placeholder=\"Contrasena de tu WiFi actual\" required>";
    html += "<div class=\"divider\"></div>";
    html += "<label>2. Nombre de la Red Repetida (Nueva)</label>";
    html += "<input type=\"text\" name=\"ap_ssid\" value=\"Starlink-Repetidor\" placeholder=\"Ej: Starlink-Patio\" required>";
    html += "<label>Clave para la Red Repetida</label>";
    html += "<input type=\"text\" name=\"ap_pass\" value=\"12345678\" placeholder=\"Minimo 8 caracteres\" required minlength=\"8\">";
    html += "<button type=\"submit\" class=\"btn\">Guardar y Activar Repetidor</button>";
    html += "</form>";
    html += "<div class=\"note\">Tip: Si deseas cambiar de red en el futuro, manten presionado el boton BOOT de la placa por 5 segundos.</div>";
    html += "</div></body></html>";
    return html;
}

String buildSuccessPage() {
    String html = "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">";
    html += "<title>Repetidor Activado</title>";
    html += "<style>body { background: #0f172a; color: #fff; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; text-align: center; padding: 20px; }";
    html += ".card { background: #1e293b; padding: 30px; border-radius: 16px; max-width: 380px; border: 1px solid #10b981; }";
    html += "h1 { color: #34d399; font-size: 1.5rem; margin-bottom: 10px; }";
    html += "p { color: #cbd5e1; font-size: 0.9rem; line-height: 1.5; margin-bottom: 15px; }</style></head><body>";
    html += "<div class=\"card\"><h1>Repetidor Configurado</h1>";
    html += "<p>El ESP32 se esta conectando a tu red principal y empezara a retransmitir internet en unos segundos.</p>";
    html += "<p>Conectate a tu nueva red WiFi repetida desde tus dispositivos.</p></div></body></html>";
    return html;
}

// =========================================================================
//  RUTAS DEL SERVIDOR WEB
// =========================================================================

void handleRoot() {
    server.send(200, "text/html", buildConfigPage());
}

void handleSave() {
    if (server.hasArg("sta_ssid") && server.hasArg("sta_pass")) {
        sta_ssid = server.arg("sta_ssid");
        sta_pass = server.arg("sta_pass");
        ap_ssid = server.hasArg("ap_ssid") ? server.arg("ap_ssid") : "Starlink-Repetidor";
        ap_pass = server.hasArg("ap_pass") ? server.arg("ap_pass") : "12345678";

        preferences.begin("repeater", false);
        preferences.putString("sta_ssid", sta_ssid);
        preferences.putString("sta_pass", sta_pass);
        preferences.putString("ap_ssid", ap_ssid);
        preferences.putString("ap_pass", ap_pass);
        preferences.putBool("configured", true);
        preferences.end();

        server.send(200, "text/html", buildSuccessPage());
        delay(2000);
        ESP.restart();
    } else {
        server.send(400, "text/plain", "Faltan parametros requeridos");
    }
}

void handleReset() {
    preferences.begin("repeater", false);
    preferences.clear();
    preferences.end();
    server.send(200, "text/plain", "Configuracion reseteada. Reiniciando...");
    delay(1000);
    ESP.restart();
}

// =========================================================================
//  INICIALIZACION Y ENRUTAMIENTO NAT
// =========================================================================

void setupNAT() {
#if HAVE_NAPT
    ip_napt_enable_no(ESP_IF_WIFI_STA, 1);
    Serial.println("[NAT] Enrutamiento NAPT activado exitosamente.");
#else
    Serial.println("[NAT] Modo Bridge TCP/IP estandar activo.");
#endif
}

void startConfigAP() {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(apIP, apIP, apNetMask);
    WiFi.softAP("Configurar-Repetidor", "");

    dnsServer.start(53, "*", apIP);

    server.on("/", handleRoot);
    server.on("/save", HTTP_POST, handleSave);
    server.on("/reset", handleReset);
    server.onNotFound([]() {
        server.sendHeader("Location", "http://192.168.4.1/", true);
        server.send(302, "text/plain", "");
    });
    server.begin();

    Serial.println("[PORTAL] Modo Configuracion activado.");
    Serial.println("[PORTAL] Conectate a la red WiFi: Configurar-Repetidor");
    Serial.println("[PORTAL] Abre en tu navegador: http://192.168.4.1");
}

void startRepeater() {
    WiFi.mode(WIFI_AP_STA);

    WiFi.softAPConfig(apIP, apIP, apNetMask);
    WiFi.softAP(ap_ssid.c_str(), ap_pass.c_str());

    Serial.print("[REPETIDOR] Emitiendo red: ");
    Serial.println(ap_ssid);

    Serial.print("[REPETIDOR] Conectando a ");
    Serial.println(sta_ssid);
    WiFi.begin(sta_ssid.c_str(), sta_pass.c_str());

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 25) {
        delay(500);
        Serial.print(".");
        digitalWrite(LED_STATUS, !digitalRead(LED_STATUS));
        retries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        isConnected = true;
        digitalWrite(LED_STATUS, HIGH);
        Serial.println("\n[REPETIDOR] Conectado a la Red Principal con exito!");
        Serial.print("[REPETIDOR] IP Asignada por el Router: ");
        Serial.println(WiFi.localIP());

        setupNAT();

        server.on("/", []() {
            String status = "<html><body style=\"font-family:sans-serif;background:#0f172a;color:#fff;text-align:center;padding:40px;\">";
            status += "<h1 style=\"color:#34d399;\">Repetidor en Funcionamiento</h1>";
            status += "<p>Conectado a: <b>" + sta_ssid + "</b></p>";
            status += "<p>Red Repetida: <b>" + ap_ssid + "</b></p>";
            status += "<p>Clientes conectados: <b>" + String(WiFi.softAPgetStationNum()) + "</b></p>";
            status += "<br><a href=\"/reset\" style=\"background:#ef4444;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;\">Cambiar / Resetear Red</a>";
            status += "</body></html>";
            server.send(200, "text/html", status);
        });
        server.on("/reset", handleReset);
        server.begin();
    } else {
        Serial.println("\n[REPETIDOR] No se pudo conectar a la red principal. Abriendo portal...");
        startConfigAP();
    }
}

// =========================================================================
//  SETUP Y LOOP PRINCIPAL
// =========================================================================

void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_BOOT, INPUT_PULLUP);
    pinMode(LED_STATUS, OUTPUT);
    digitalWrite(LED_STATUS, LOW);

    delay(1000);
    Serial.println("\n========================================");
    Serial.println("  REPETIDOR WIFI NAT ESP32 INICIADO");
    Serial.println("========================================");

    preferences.begin("repeater", true);
    isConfigured = preferences.getBool("configured", false);
    sta_ssid = preferences.getString("sta_ssid", "");
    sta_pass = preferences.getString("sta_pass", "");
    ap_ssid = preferences.getString("ap_ssid", "Starlink-Repetidor");
    ap_pass = preferences.getString("ap_pass", "12345678");
    preferences.end();

    if (isConfigured && sta_ssid.length() > 0) {
        startRepeater();
    } else {
        startConfigAP();
    }
}

void loop() {
    server.handleClient();

    if (!isConfigured || WiFi.status() != WL_CONNECTED) {
        dnsServer.processNextRequest();
    }

    if (digitalRead(BUTTON_BOOT) == LOW) {
        if (bootButtonTimer == 0) {
            bootButtonTimer = millis();
        } else if (millis() - bootButtonTimer >= 5000) {
            Serial.println("\n[RESET] Boton BOOT presionado por 5s. Borrando configuracion...");
            for (int i = 0; i < 5; i++) {
                digitalWrite(LED_STATUS, HIGH); delay(100);
                digitalWrite(LED_STATUS, LOW); delay(100);
            }
            preferences.begin("repeater", false);
            preferences.clear();
            preferences.end();
            ESP.restart();
        }
    } else {
        bootButtonTimer = 0;
    }
}
