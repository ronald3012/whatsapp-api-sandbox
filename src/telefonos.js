/**
 * ¿Ese número tiene forma de número de WhatsApp?
 *
 * Meta pide el número en formato internacional: código de país delante, sin
 * «+», sin guiones. Sin código de país no hay a quién entregarle —«8097771010»
 * podría ser de media docena de países— y Meta lo rechaza.
 *
 * El sandbox lo aceptaba, y por eso una conversación de ensayo funcionaba aquí
 * y habría fallado contra Meta: exactamente lo contrario de para lo que existe
 * este clon.
 *
 * La comprobación de verdad es que empiece por un código de país que exista.
 * Solo mirar la longitud no sirve: 8097771010 tiene diez dígitos, una longitud
 * perfectamente normal, y aun así no empieza por ningún código de país (809 no
 * lo es; el de Dominicana es el 1).
 */

/** Los códigos de llamada de la UIT, de 1 a 3 dígitos. */
const CODIGOS = new Set([
  "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45",
  "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63",
  "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225", "226", "227",
  "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240",
  "241", "242", "243", "244", "245", "246", "248", "249", "250", "251", "252", "253", "254",
  "255", "256", "257", "258", "260", "261", "262", "263", "264", "265", "266", "267", "268",
  "269", "290", "291", "297", "298", "299", "350", "351", "352", "353", "354", "355", "356",
  "357", "358", "359", "370", "371", "372", "373", "374", "375", "376", "377", "378", "380",
  "381", "382", "383", "385", "386", "387", "389", "420", "421", "423", "500", "501", "502",
  "503", "504", "505", "506", "507", "508", "509", "590", "591", "592", "593", "594", "595",
  "596", "597", "598", "599", "670", "672", "673", "674", "675", "676", "677", "678", "679",
  "680", "681", "682", "683", "685", "686", "687", "688", "689", "690", "691", "692", "850",
  "852", "853", "855", "856", "880", "886", "960", "961", "962", "963", "964", "965", "966",
  "967", "968", "970", "971", "972", "973", "974", "975", "976", "977", "992", "993", "994",
  "995", "996", "998",
]);

/**
 * Devuelve el motivo por el que NO vale, o null si está bien.
 * El motivo se escribe pensando en quien lo va a leer en la pantalla.
 */
export function porQueNoEsTelefono(crudo) {
  const d = String(crudo ?? "").replace(/\D/g, "");
  if (!d) return "hace falta el número";
  if (d.startsWith("0")) return "un número internacional no empieza por 0: va el código de país delante";
  // E.164: 15 dígitos como mucho, y por debajo de 8 no hay número internacional.
  if (d.length < 8) return `«${d}» es muy corto para un número con código de país`;
  if (d.length > 15) return `«${d}» tiene ${d.length} dígitos; el máximo son 15`;
  for (const largo of [3, 2, 1]) {
    if (CODIGOS.has(d.slice(0, largo))) return null;
  }
  return `«${d}» no empieza por ningún código de país (para Dominicana sería 1${d})`;
}

export const esTelefonoValido = (crudo) => porQueNoEsTelefono(crudo) === null;
