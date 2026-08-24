/*
 * =========================================================================
 *  RADAR DE PUERTA CALIBRADO DE ALTA PRECISION (ESP32 V2.0)
 * =========================================================================
 *  - Umbral estricto: Solo detecta personas a menos de 1.5 metros de la puerta.
 *  - Filtro Anti-Vecinos: Descarta senales lejanas a traves de paredes.
 *  - Filtro de Aparatos Fijos: Ignora Smart TVs, laptops y routers estaticos.
 *  - Alerta de Llegada Inmediata con parpadeo LED.
 * =========================================================================
 */

#include <WiFi.h>
#include "esp_wifi.h"

#define LED_STATUS 2

// UMBRAL ESTRICTO DE PUERTA (Aprox. 0 a 1.5 metros de la placa)
#define RSSI_PUERTA_ESTRICTO -48   // Senales muy potentes e inmediatas
#define RSSI_CORTE_RUIDO     -55   // Todo lo menor a -55 dBm se descarta (vecinos/calle)
#define TIEMPO_EXPIRACION    20000 // 20 segundos sin senal = la persona se retiro de la puerta

const uint8_t channels[] = {1, 6, 11, 2, 7, 3, 8, 4, 9, 5, 10, 12, 13};
int currentChannelIndex = 0;
unsigned long lastChannelHop = 0;

struct PersonaPuerta {
    String mac;
    int rssi;
    unsigned long firstSeen;
    unsigned long lastSeen;
    String osType;
    bool isStaticDevice; // Dispositivo fijo (TV, PC, etc.)
};

const int MAX_PERSONS = 30;
PersonaPuerta doorPersons[MAX_PERSONS];
int totalInDoor = 0;

unsigned long lastScreenUpdate = 0;

// =========================================================================
//  IDENTIFICACION DE FABRICANTE / SISTEMA OPERATIVO
// =========================================================================
String identifyPhoneOS(uint8_t* payload, int len) {
    uint8_t* mac = &payload[10];

    // Apple (iPhones / Apple Watch)
    if ((mac[0] == 0xBC && mac[1] == 0xD0 && mac[2] == 0x74) ||
        (mac[0] == 0xF4 && mac[1] == 0x37 && mac[2] == 0xB7) ||
        (mac[0] == 0xA4 && mac[1] == 0xC3 && mac[2] == 0x61) ||
        (mac[0] == 0xF0 && mac[1] == 0x18 && mac[2] == 0x98) ||
        (mac[0] == 0x38 && mac[1] == 0xF9 && mac[2] == 0xD3) ||
        (mac[0] == 0xDC && mac[1] == 0xA9 && mac[2] == 0x04)) {
        return "🍎 iPhone (Apple iOS)";
    }

    // Android de Fabrica
    if ((mac[0] == 0x50 && mac[1] == 0x01 && mac[2] == 0xD9) ||
        (mac[0] == 0x84 && mac[1] == 0x25 && mac[2] == 0x19) ||
        (mac[0] == 0x34 && mac[1] == 0x14 && mac[2] == 0x5F) ||
        (mac[0] == 0xAC && mac[1] == 0x5F && mac[2] == 0x3E)) {
        return "🤖 Android (Samsung)";
    }
    if ((mac[0] == 0x28 && mac[1] == 0x6C && mac[2] == 0x07) ||
        (mac[0] == 0x64 && mac[1] == 0x09 && mac[2] == 0x80) ||
        (mac[0] == 0x74 && mac[1] == 0x23 && mac[2] == 0x44)) {
        return "🤖 Android (Xiaomi)";
    }

    // Busqueda de Tags internas en el paquete
    for (int i = 24; i < len - 4; i++) {
        if (payload[i] == 0x00 && payload[i+1] == 0x17 && payload[i+2] == 0xF2) {
            return "🍎 iPhone (Apple iOS)";
        }
        if (payload[i] == 0x50 && payload[i+1] == 0x6F && payload[i+2] == 0x9A) {
            return "🤖 Celular Android";
        }
        if (payload[i] == 0x00 && payload[i+1] == 0x50 && payload[i+2] == 0xF2 && payload[i+3] == 0x04) {
            return "🤖 Celular Android";
        }
    }

    if (mac[0] & 0x02) {
        return (len < 100) ? "🍎 iPhone (Apple iOS)" : "🤖 Celular Android";
    }

    return "📱 Smartphone";
}

// =========================================================================
//  CALLBACK DEL SNIFFER (Solo acepta senales ultra cercanas)
// =========================================================================
void sniffer_callback(void* buf, wifi_promiscuous_pkt_type_t type) {
    if (type != WIFI_PKT_MGMT) return;

    wifi_promiscuous_pkt_t* pkt = (wifi_promiscuous_pkt_t*)buf;
    int rssi = pkt->rx_ctrl.rssi;

    // FILTRO ESTRICTO: Descarta el 100% de vecinos y calle (> 1.5 metros)
    if (rssi < RSSI_CORTE_RUIDO) return;

    uint8_t* payload = pkt->payload;
    int len = pkt->rx_ctrl.sig_len;

    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             payload[10], payload[11], payload[12], payload[13], payload[14], payload[15]);

    String mac = String(macStr);
    unsigned long now = millis();

    // 1. Si ya esta registrado en la puerta, actualizamos su presencia
    for (int i = 0; i < totalInDoor; i++) {
        if (doorPersons[i].mac == mac) {
            doorPersons[i].rssi = rssi;
            doorPersons[i].lastSeen = now;

            // Si lleva mas de 2 minutos pegado a la misma potencia, es un aparato fijo de la casa
            if (now - doorPersons[i].firstSeen > 120000) {
                doorPersons[i].isStaticDevice = true;
            }
            return;
        }
    }

    // 2. NUEVA PERSONA LLEGANDO A LA PUERTA
    if (totalInDoor < MAX_PERSONS) {
        doorPersons[totalInDoor].mac = mac;
        doorPersons[totalInDoor].rssi = rssi;
        doorPersons[totalInDoor].firstSeen = now;
        doorPersons[totalInDoor].lastSeen = now;
        doorPersons[totalInDoor].osType = identifyPhoneOS(payload, len);
        doorPersons[totalInDoor].isStaticDevice = false;
        totalInDoor++;

        // Alerta visual inmediata en la placa (3 destellos rapidos)
        for (int b = 0; b < 3; b++) {
            digitalWrite(LED_STATUS, HIGH); delay(40);
            digitalWrite(LED_STATUS, LOW); delay(40);
        }

        Serial.println("\n🚨 >>> [ALERTA DE LLEGADA EN PUERTA] <<<");
        Serial.printf("   👤 Nuevo dispositivo a ~%.1f metros: %s (MAC: %s)\n\n",
                      pow(10, (-42.0 - rssi) / (10.0 * 2.4)),
                      doorPersons[totalInDoor-1].osType.c_str(),
                      mac.c_str());
    }
}

// =========================================================================
//  SETUP
// =========================================================================
void setup() {
    Serial.begin(115200);
    pinMode(LED_STATUS, OUTPUT);
    digitalWrite(LED_STATUS, LOW);

    delay(1000);
    Serial.println("\n========================================================");
    Serial.println("  RADAR DE PUERTA ALTA PRECISION (Filtro < 1.5m)");
    Serial.println("========================================================");
    Serial.println("[FILTRO] Ignorando vecinos, calle y aparatos estaticos.");
    Serial.println("[RANGO] Vigilando exclusivamente la zona inmediata de la puerta.\n");

    WiFi.mode(WIFI_STA);
    WiFi.disconnect();

    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(&sniffer_callback);
    esp_wifi_set_channel(channels[0], WIFI_SECOND_CHAN_NONE);
}

// =========================================================================
//  LOOP PRINCIPAL
// =========================================================================
void loop() {
    unsigned long now = millis();

    // Salto de canales rapido
    if (now - lastChannelHop >= 200) {
        lastChannelHop = now;
        currentChannelIndex = (currentChannelIndex + 1) % (sizeof(channels) / sizeof(channels[0]));
        esp_wifi_set_channel(channels[currentChannelIndex], WIFI_SECOND_CHAN_NONE);
    }

    // Limpieza de personas que ya se fueron de la puerta (> 20 segundos)
    for (int i = 0; i < totalInDoor; i++) {
        if (now - doorPersons[i].lastSeen > TIEMPO_EXPIRACION) {
            Serial.printf("🚪 [SALIDA] Persona se retiro de la puerta: %s\n", doorPersons[i].osType.c_str());
            for (int j = i; j < totalInDoor - 1; j++) {
                doorPersons[j] = doorPersons[j + 1];
            }
            totalInDoor--;
            i--;
        }
    }

    // Actualizacion limpia del panel cada 2.5 segundos
    if (now - lastScreenUpdate >= 2500) {
        lastScreenUpdate = now;

        int realPersons = 0;
        for (int i = 0; i < totalInDoor; i++) {
            if (!doorPersons[i].isStaticDevice && doorPersons[i].rssi >= RSSI_PUERTA_ESTRICTO) {
                realPersons++;
            }
        }

        Serial.println("--------------------------------------------------------");
        Serial.printf(" 🚪 PERSONAS REALES PARADAS EN LA PUERTA: %d\n", realPersons);
        Serial.println("--------------------------------------------------------");

        if (realPersons == 0) {
            Serial.println("  🟢 Puerta Despejada (Nadie al frente)");
        } else {
            for (int i = 0; i < totalInDoor; i++) {
                if (!doorPersons[i].isStaticDevice && doorPersons[i].rssi >= RSSI_PUERTA_ESTRICTO) {
                    float meters = pow(10, (-42.0 - doorPersons[i].rssi) / (10.0 * 2.4));
                    int secondsAgo = (now - doorPersons[i].lastSeen) / 1000;
                    Serial.printf("  👉 [PRESENTE] %-23s | ~%.1fm | %d dBm | Hace %ds\n",
                                  doorPersons[i].osType.c_str(),
                                  meters,
                                  doorPersons[i].rssi,
                                  secondsAgo);
                }
            }
        }
        Serial.println("--------------------------------------------------------\n");
    }
}
