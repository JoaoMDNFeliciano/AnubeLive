# AnubeLive

Classificações ao vivo das provas cronometradas pela **Anube Sport** (anubesport.com):
escolhe a prova, a corrida (carros e/ou motos) e os números dos pilotos a acompanhar.

## Arrancar no Windows
Duplo clique em **`Iniciar AnubeLive.bat`** → abre `http://localhost:8765` no browser.
(Requer Python 3. Fechar a janela preta pára a app.)

No Chrome/Edge podes instalá-la como app: ícone "Instalar" na barra de endereço.

## O que mostra
- Lista de provas: a decorrer, próximas e passadas (filtros por tipo, país e pesquisa).
- Para cada piloto, posição em **cada intermédio** e no **final de cada especial**,
  em modo **Na especial** ou **À geral** (nos intermédios, geral provisória =
  acumulado oficial até à especial anterior + tempo no intermédio).
- Em todas as classificações do piloto: Geral, Categoria, Classe, Grupo e Campeonatos.
- Os **3 pilotos à frente e 3 atrás em cada classificação** (uma tabela por Geral, Categoria,
  Classe, Grupo e Campeonato; botão + / − para mostrar ou esconder cada uma), com tempo,
  diferença para o piloto e para o líder.
  (Diferença negativa = esse piloto está à frente por esse tempo.)
- Botão ☀ / ☾ no topo para mudar entre modo dia (claro, melhor ao sol) e modo noite (escuro).
- Alertas: mudança de posição, novo tempo, abandono/penalização (toast, som, vibração
  e notificação do sistema quando a app está em segundo plano).

## Avisos de proximidade (5 · 2 · 1 km)
No ecrã "Ao vivo", **📍 Avisos de proximidade → Ligar**. A app cruza a posição GPS dos pilotos
que acompanhas (mapa de tracking público da Anube) com a localização do telemóvel:
- Sirene + mensagem a piscar no ecrã durante 5 s aos 5, 2 e 1 km. O som escolhe-se nas
  Definições: ambulância, bombeiros, polícia, ataque aéreo, campainha de escola ou telefone antigo.
- Distância **pela estrada** quando a Anube publica o traçado da especial; senão **em linha reta**.
- Botão **📌 Fixar aqui** grava o ponto onde estás (útil se o GPS falhar); **🔔/🔕** silencia um piloto.
- Posições dos pilotos lidas a cada 10 s. Só funciona com a app aberta e o ecrã ligado.
- Só funciona em provas com mapa de tracking público.

## Usar no Android
Para instalar no Android a app tem de estar num endereço **https** (ex.: GitHub Pages).
Enquanto isso não acontece, com o PC e o telemóvel na mesma rede Wi-Fi, abre no telemóvel
o endereço que `serve.py` mostra (`http://IP-do-PC:8765`) — funciona no browser, mas sem
instalação nem notificações do sistema (o Windows pode pedir para autorizar o Python na firewall).

## Notas técnicas
- Fontes de dados (públicas, as mesmas que o site usa):
  - `https://anubesport.com/es/events` — lista de provas (embutida no HTML)
  - `https://rest3.anube.es/rallyrest/timing/api/` — `race`, `itineraries`, `specials`,
    `participants`, `chronos2`, `partials`, `classification`, `penalizations`
- Tempo no intermédio = passagem − partida oficial (`chronos2.ut_start`), tal como o site oficial.
- Especiais terminadas são revistas de 2 em 2 minutos; especiais ao vivo a cada atualização.
- Sem dependências nem compilação: HTML + CSS + JavaScript (módulos ES).
- `tools/make_icons.py` regenera os ícones PNG.
