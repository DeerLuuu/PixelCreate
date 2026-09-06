// Built-in preset palettes for quick loading
export interface PalettePack {
  id: string;
  nameZh: string;
  nameEn: string;
  colors: string[]; // hex
}

export const PALETTE_PACKS: PalettePack[] = [
  {
    id: "default",
    nameZh: "默认",
    nameEn: "Default",
    colors: [
      "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
      "#ffffff", "#9badb7", "#6a5acd", "#ff6347", "#ffd700", "#00fa9a", "#40e0d0", "#ff69b4",
    ],
  },
  {
    id: "db16",
    nameZh: "DB16",
    nameEn: "DB16",
    colors: [
      "#140c1c", "#442434", "#30346d", "#4e4a4e", "#854c30", "#346524", "#d04648", "#757161",
      "#597dce", "#d27d2c", "#8595a1", "#6daa2c", "#d2aa99", "#6dc2ca", "#dad45e", "#deeed6",
    ],
  },
  {
    id: "pico8",
    nameZh: "PICO-8",
    nameEn: "PICO-8",
    colors: [
      "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
    ],
  },
  {
    id: "sweetie16",
    nameZh: "Sweetie-16",
    nameEn: "Sweetie-16",
    colors: [
      "#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179",
      "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57",
    ],
  },
  {
    id: "gray",
    nameZh: "灰阶",
    nameEn: "Grays",
    colors: ["#000000", "#1a1a1a", "#333333", "#4d4d4d", "#666666", "#808080", "#999999", "#b3b3b3", "#cccccc", "#e6e6e6", "#ffffff"],
  },
];
