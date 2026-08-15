/**
 * Codecs aceitos pelo router. A ordem importa: o primeiro video codec
 * compatível com o cliente costuma ser o escolhido.
 *
 * VP8 vem primeiro porque tem o melhor suporte em Chromium/Electron e lida
 * bem com compartilhamento de tela (conteudo estático + texto). H264 fica
 * como alternativa para quem tiver aceleração de hardware.
 */
export const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      // Voz em estereo não ajuda e gasta banda; mono com DTX economiza upload.
      useinbandfec: 1,
      usedtx: 1,
      maxplaybackrate: 48000,
      'sprop-stereo': 0,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

/**
 * Camadas de simulcast usadas no compartilhamento de tela.
 * Com 10 pessoas na sala, quem tem internet ruim recebe a camada baixa
 * sem derrubar a qualidade de todo mundo.
 */
export const screenShareEncodings = [
  { rid: 'r0', maxBitrate: 600_000, scaleResolutionDownBy: 4, scalabilityMode: 'L1T1' },
  { rid: 'r1', maxBitrate: 2_000_000, scaleResolutionDownBy: 2, scalabilityMode: 'L1T1' },
  { rid: 'r2', maxBitrate: 6_000_000, scaleResolutionDownBy: 1, scalabilityMode: 'L1T1' },
];
