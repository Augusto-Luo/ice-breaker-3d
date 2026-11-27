# CTSC Quebra-Gelo Polar 3D

[English](README.md) · [中文](README.zh-CN.md) · **Português**

Uma cena interativa 3D de navegação polar no estilo **Ligne Claire / ilustração arquitetônica editorial japonesa**, desenvolvida com **Three.js** e um pipeline GLSL multipasse personalizado — 100% procedural, sem modelos 3D ou texturas externas.

![Visão Geral em Estilo Ilustração](docs/preview-illustration.png)

## Destaques

- **Pipeline Ligne Claire Multipasse**: Reflexo planar em tempo real na água + passo cel-shaded com MSAA + G-Buffer de normal octaédrica, profundidade linear e ID de peça + contornos nítidos em nanquim (Roberts Cross) + textura sutil de papel prensado a frio.
- **Mar Polar Contido e Esteira de Kelvin 3D**: Ondulação trocoidal em azul-da-prússia profundo, ondas de Kelvin 3D em V e rolos de popa, reflexos planares suavemente absorvidos, espuma de hélices duplas e brilhos solares discretos.
- **Fratura Voronoi em Tempo Real e Física 6-DOF de Blocos de Gelo**: Banquisa ativa tesselada em células Voronoi convexas contínuas fundidas sem emendas ao campo de neve infinito, subdivisão radial e circunferencial centrada na proa (com relaxação de Lloyd, sem lascas degeneradas), propagação real de fissuras à frente da proa com flexão da borda, desprendimento exato complementar (textura de neve travada por bloco), fragmentação secundária e flutuação 6-DOF por quatérnios com tombamento de 180° pela proa tipo colher (revelando a face inferior glacial azul-úmida), trânsito sob o casco, empilhamento sob a banquisa (*rafting*) e abertura livre de canais em qualquer direção.
- **Condução Pesada de 15.000 Toneladas e Impacto em Baixa Velocidade**: Telégrafo do passadiço separado da inércia lenta do eixo propulsor, leme hidráulico pesado com deriva lateral, períodos lentos de balanço (~3s) e contato tátil em baixa velocidade (proa sobe sobre a borda do gelo, vibra, detém-se e recua suavemente).
- **Arquitetura Detalhada do Quebra-Gelo (`CTSC`)**: Casco polar com proa tipo colher, superestrutura compacta com asas de passadiço esguias, chaminé chanfrada com fuligem, mastro de radar e torre treliçada à ré, helideque chanfrado com rede de segurança e porta do hangar, baleeiras laranja e desgaste marítimo gráfico.
- **Interface Trilíngue (`中文 / EN / PT`) e 5 Câmeras Fixas**: Troca rápida no canto superior direito, tecla `L`, detecção do idioma do navegador ou `?lang=zh|en|pt`; 5 enquadramentos editoriais curados.

![Detalhe Arquitetônico da Ponte e Blocos de Gelo](docs/preview-detail.png)

## Controles

| Comando | Ação |
| --- | --- |
| **W / S** ou **↑ / ↓** | Telégrafo do motor (Avante / Ré) — baixa potência (~15–25%) encosta e recua no gelo; ≥34% rompe a banquisa |
| **A / D** ou **← / →** | Leme hidráulico Bombordo / Boreste — inércia de guinada pesada e toques laterais na borda do gelo |
| **Espaço** | Parar máquinas / desaceleração por inércia |
| **1 – 5** ou **C** | Alternar entre as 5 câmeras fixas |
| **L** | Alternar idioma (`中` → `EN` → `PT`) |
| **R** | Reiniciar rota e banquisa |
| **H** | Ocultar / mostrar interface (Modo Ilustração Limpa) |

## Executar Localmente

```bash
npm install
npm run dev
```

Compilar e pré-visualizar a versão de produção:

```bash
npm run build
npm run preview
```

## Publicar no GitHub Pages

O repositório já inclui o workflow `.github/workflows/deploy.yml`:

1. Envie o repositório para o GitHub na branch `main`.
2. Em **Settings → Pages**, selecione **GitHub Actions** em **Source**.
3. O site interativo será compilado e publicado automaticamente a cada push.

## Licença

[MIT](LICENSE)
