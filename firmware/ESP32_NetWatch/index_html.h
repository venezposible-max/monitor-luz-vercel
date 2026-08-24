#ifndef INDEX_HTML_H
#define INDEX_HTML_H

const char INDEX_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NetWatch - Auditor 24/7</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0b0f19; color: #f8fafc; padding: 16px; display: flex; justify-content: center; }
        .container { width: 100%; max-width: 720px; }
        header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #1e293b; }
        h1 { font-size: 1.4rem; color: #38bdf8; display: flex; align-items: center; gap: 8px; font-weight: 800; letter-spacing: -0.5px; }
        .badge { font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 99px; text-transform: uppercase; }
        .badge-live { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid #38bdf8; }
        
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .card { background: #131b2e; border: 1px solid #1e293b; border-radius: 14px; padding: 16px; display: flex; flex-direction: column; }
        .card-title { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; letter-spacing: 0.5px; }
        .card-value { font-size: 1.6rem; font-weight: 800; color: #fff; }
        .card-sub { font-size: 0.75rem; margin-top: 4px; color: #64748b; }
        
        .section-title { font-size: 0.95rem; font-weight: 700; color: #cbd5e1; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        
        .chart-box { background: #131b2e; border: 1px solid #1e293b; border-radius: 14px; padding: 16px; margin-bottom: 20px; }
        .bars { display: flex; align-items: flex-end; gap: 6px; height: 100px; padding-top: 10px; }
        .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
        .bar { width: 100%; border-radius: 4px; transition: height 0.4s ease; min-height: 4px; }
        .bar-val { font-size: 0.65rem; color: #64748b; margin-top: 4px; }
        
        .table-box { background: #131b2e; border: 1px solid #1e293b; border-radius: 14px; overflow: hidden; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
        th { background: #1e293b; color: #94a3b8; padding: 10px 14px; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
        td { padding: 12px 14px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
        tr:last-child td { border-bottom: none; }
        
        .btn-box { display: flex; gap: 10px; }
        .btn { flex: 1; padding: 12px; border-radius: 10px; font-size: 0.9rem; font-weight: 700; border: none; cursor: pointer; text-align: center; text-decoration: none; transition: 0.2s; }
        .btn-report { background: linear-gradient(135deg, #0284c7, #0369a1); color: #fff; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3); }
        .btn-reset { background: #1e293b; color: #ef4444; border: 1px solid #ef4444; }
        
        .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); justify-content: center; align-items: center; padding: 16px; z-index: 99; }
        .modal-card { background: #131b2e; border: 1px solid #38bdf8; border-radius: 16px; padding: 24px; max-width: 500px; width: 100%; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
        .modal-card h2 { font-size: 1.2rem; color: #38bdf8; margin-bottom: 12px; }
        .modal-card pre { background: #0b0f19; border: 1px solid #1e293b; padding: 12px; border-radius: 8px; font-size: 0.78rem; color: #cbd5e1; white-space: pre-wrap; font-family: monospace; max-height: 250px; overflow-y: auto; margin-bottom: 16px; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>NetWatch <span class="badge badge-live">Auditor 24/7</span></h1>
            <div id="connectionStatus" class="badge" style="background:#10b981; color:#fff;">ONLINE</div>
        </header>

        <div class="grid">
            <div class="card">
                <div class="card-title">Latencia (Ping)</div>
                <div class="card-value" id="pingValue">-- ms</div>
                <div class="card-sub" id="pingQuality">Calculando...</div>
            </div>
            <div class="card">
                <div class="card-title">Disponibilidad</div>
                <div class="card-value" id="uptimeValue" style="color:#38bdf8;">--%</div>
                <div class="card-sub">Calidad de Servicio</div>
            </div>
            <div class="card">
                <div class="card-title">Microcortes Hoy</div>
                <div class="card-value" id="outagesCount" style="color:#f59e0b;">0</div>
                <div class="card-sub" id="totalOutageTime">0 seg sin servicio</div>
            </div>
        </div>

        <div class="section-title">
            <span>Latencia en Vivo (Ultimos 20 chequeos)</span>
            <span style="font-size:0.75rem; color:#64748b;">Actualiza cada 3s</span>
        </div>
        <div class="chart-box">
            <div class="bars" id="barsContainer"></div>
        </div>

        <div class="section-title">
            <span>Historial de Caidas e Interrupciones</span>
        </div>
        <div class="table-box">
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Inicio de Caida</th>
                        <th>Reconexion</th>
                        <th>Duracion</th>
                    </tr>
                </thead>
                <tbody id="outagesTableBody">
                    <tr><td colspan="4" style="text-align:center; color:#64748b;">No se registran caidas de internet</td></tr>
                </tbody>
            </table>
        </div>

        <div class="btn-box">
            <button class="btn btn-report" onclick="showReport()">Generar Informe Tecnico para Reclamo</button>
            <a href="/reset" class="btn btn-reset" onclick="return confirm('Deseas desconfigurar el WiFi y reiniciar')">Cambiar WiFi</a>
        </div>
    </div>

    <!-- Modal de Reporte -->
    <div class="modal" id="reportModal">
        <div class="modal-card">
            <h2>Informe Tecnico de Conectividad</h2>
            <pre id="reportText"></pre>
            <button class="btn btn-report" style="width:100%;" onclick="copyReport()">Copiar Texto para Enviar al Proveedor</button>
            <button class="btn btn-reset" style="width:100%; margin-top:8px; border:none; background:transparent; color:#94a3b8;" onclick="closeReport()">Cerrar</button>
        </div>
    </div>

    <script>
        let lastData = {};

        const fetchStatus = async () => {
            try {
                const res = await fetch("/api/status");
                const data = await res.json();
                lastData = data;

                const statusBadge = document.getElementById("connectionStatus");
                if (data.isOnline) {
                    statusBadge.style.background = "#10b981";
                    statusBadge.innerText = "SERVICIO ONLINE";
                } else {
                    statusBadge.style.background = "#ef4444";
                    statusBadge.innerText = "INTERNET CAIDO";
                }

                const pingEl = document.getElementById("pingValue");
                const qualityEl = document.getElementById("pingQuality");
                if (data.isOnline && data.currentPing >= 0) {
                    pingEl.innerText = data.currentPing + " ms";
                    if (data.currentPing < 50) {
                        pingEl.style.color = "#10b981";
                        qualityEl.innerText = "Excelente (Fibra Optima)";
                    } else if (data.currentPing < 120) {
                        pingEl.style.color = "#f59e0b";
                        qualityEl.innerText = "Regular (Aceptable)";
                    } else {
                        pingEl.style.color = "#ef4444";
                        qualityEl.innerText = "Alta Latencia / Lag";
                    }
                } else {
                    pingEl.innerText = "ERR";
                    pingEl.style.color = "#ef4444";
                    qualityEl.innerText = "Sin Respuesta";
                }

                document.getElementById("uptimeValue").innerText = data.uptimePercent.toFixed(1) + "%";
                document.getElementById("outagesCount").innerText = data.totalOutages;
                document.getElementById("totalOutageTime").innerText = data.totalOutageDurationStr;

                const barsContainer = document.getElementById("barsContainer");
                barsContainer.innerHTML = "";
                const maxVal = Math.max(...data.pingHistory, 100);
                data.pingHistory.forEach(val => {
                    const col = document.createElement("div");
                    col.className = "bar-col";
                    const bar = document.createElement("div");
                    bar.className = "bar";
                    const h = val > 0 ? (val / maxVal) * 100 : 5;
                    bar.style.height = h + "%";
                    bar.style.background = val > 0 ? (val < 50 ? "#10b981" : (val < 120 ? "#f59e0b" : "#ef4444")) : "#334155";
                    const label = document.createElement("div");
                    label.className = "bar-val";
                    label.innerText = val > 0 ? val : "x";
                    col.appendChild(bar);
                    col.appendChild(label);
                    barsContainer.appendChild(col);
                });

                const tbody = document.getElementById("outagesTableBody");
                if (data.outages && data.outages.length > 0) {
                    tbody.innerHTML = "";
                    data.outages.slice().reverse().forEach((outage, i) => {
                        const tr = document.createElement("tr");
                        tr.innerHTML = "<td><b>#" + outage.id + "</b></td><td>" + outage.start + "</td><td>" + outage.end + "</td><td><span style='color:#ef4444; font-weight:700;'>" + outage.duration + "</span></td>";
                        tbody.appendChild(tr);
                    });
                }
            } catch (e) {
                console.log("Error polling status", e);
            }
        };

        const showReport = () => {
            const dateStr = new Date().toLocaleDateString("es-VE");
            let text = "=================================================\n";
            text += "   INFORME TECNICO DE CALIDAD DE SERVICIO (SLA)\n";
            text += "=================================================\n";
            text += "Fecha de Auditoria: " + dateStr + "\n";
            text += "Disponibilidad Real: " + (lastData.uptimePercent ? lastData.uptimePercent.toFixed(2) : "--") + "%\n";
            text += "Total de Caidas/Microcortes: " + (lastData.totalOutages || 0) + " eventos\n";
            text += "Tiempo Total sin Servicio: " + (lastData.totalOutageDurationStr || "0 seg") + "\n";
            text += "Latencia Promedio: " + (lastData.currentPing || "--") + " ms\n";
            text += "-------------------------------------------------\n";
            text += "DETALLE CRONOLOGICO DE INTERRUPCIONES:\n";
            if (lastData.outages && lastData.outages.length > 0) {
                lastData.outages.forEach(o => {
                    text += "• Corte #" + o.id + ": Inicio [" + o.start + "] -> Fin [" + o.end + "] (Duracion: " + o.duration + ")\n";
                });
            } else {
                text += "• No se registraron interrupciones en el periodo evaluado.\n";
            }
            text += "=================================================\n";
            text += "Generado automaticamente por NetWatch 24/7.";

            document.getElementById("reportText").innerText = text;
            document.getElementById("reportModal").style.display = "flex";
        };

        const closeReport = () => {
            document.getElementById("reportModal").style.display = "none";
        };

        const copyReport = () => {
            const text = document.getElementById("reportText").innerText;
            navigator.clipboard.writeText(text);
            alert("Informe copiado al portapapeles! Puedes pegarlo directamente en WhatsApp o enviarlo a tu proveedor.");
        };

        setInterval(fetchStatus, 3000);
        fetchStatus();
    </script>
</body>
</html>
)rawhtml";

#endif
