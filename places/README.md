# Locais da organização, por prova

Um ficheiro por prova: `places/<id da prova>.json`
(ex.: Baja TT Escuderia Castelo Branco 2026 = `7199.json`).

Formato:

```json
[
  { "type": "pf",     "name": "Parque Fechado – Praça X",   "lat": 39.8197, "lon": -7.4931, "note": "sábado 18h" },
  { "type": "assist", "name": "Assistência – Zona Industrial", "lat": 39.8301, "lon": -7.5102 },
  { "type": "gas",    "name": "GAS 1 – km 72",               "lat": 39.7712, "lon": -7.6630 },
  { "type": "ze",     "name": "ZE 3 – Ribeira",              "lat": 39.7945, "lon": -7.6512, "note": "acesso pela EM 1006" }
]
```

Tipos (`type`): `pf` parque fechado · `start` partida SS/prólogo · `finish` chegada SS/prólogo ·
`assist` zona de assistência · `gas` GAS (reabastecimento) · `fuel` bomba de gasolina · `ze` zona espetáculo.

As partidas e chegadas também vêm automaticamente quando são publicadas, e as bombas de
gasolina vêm do OpenStreetMap; este ficheiro serve para os restantes locais (dados do Sportity).
