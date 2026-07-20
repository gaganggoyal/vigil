'use strict';

const dgram = require('dgram');
const os = require('os');

/**
 * Best-effort ONVIF camera discovery via WS-Discovery.
 *
 * We send a SOAP "Probe" to the standard multicast group 239.255.255.250:3702
 * and collect replies. Most WiFi CCTV cameras answer with their ONVIF service
 * address, from which we pull the IP. We can't guess the exact RTSP path
 * without authenticating, so we hand the IP back to the UI along with a list of
 * common RTSP URL patterns the user can try.
 */
const PROBE = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${randomUuid()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>`;

function randomUuid() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/** Common RTSP path templates by loose vendor guess — shown as suggestions. */
const RTSP_HINTS = [
  { label: 'Generic / Hikvision', path: '/Streaming/Channels/101' },
  { label: 'Generic sub-stream', path: '/Streaming/Channels/102' },
  { label: 'Dahua / Amcrest', path: '/cam/realmonitor?channel=1&subtype=0' },
  { label: 'Reolink', path: '/h264Preview_01_main' },
  { label: 'TP-Link / Tapo', path: '/stream1' },
  { label: 'ONVIF default', path: '/onvif1' },
  { label: 'Common', path: '/live/ch0' },
  { label: 'Common', path: '/11' },
];

function discover(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Map(); // ip -> { ip, xaddrs }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', () => {
      try { socket.close(); } catch {}
      resolve(finish());
    });

    socket.on('message', (msg) => {
      const text = msg.toString();
      const addrs = [...text.matchAll(/https?:\/\/([^/\s<]+)/g)].map((m) => m[1]);
      for (const hostPort of addrs) {
        const ip = hostPort.split(':')[0];
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && !found.has(ip)) {
          found.set(ip, { ip, xaddrs: hostPort });
        }
      }
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
      } catch {}
      // Send the probe out of every IPv4 interface so we reach all subnets.
      const buf = Buffer.from(PROBE);
      const ifaces = os.networkInterfaces();
      const sent = new Set();
      for (const list of Object.values(ifaces)) {
        for (const ni of list || []) {
          if (ni.family === 'IPv4' && !ni.internal && !sent.has(ni.address)) {
            sent.add(ni.address);
            try { socket.setMulticastInterface(ni.address); } catch {}
            socket.send(buf, 0, buf.length, 3702, '239.255.255.250');
          }
        }
      }
      // Also a plain send in case no external iface was found.
      socket.send(buf, 0, buf.length, 3702, '239.255.255.250');
    });

    function finish() {
      return [...found.values()].map((d) => ({
        ip: d.ip,
        xaddrs: d.xaddrs,
        suggestions: RTSP_HINTS.map((h) => ({
          label: h.label,
          url: `rtsp://USER:PASS@${d.ip}:554${h.path}`,
        })),
      }));
    }

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(finish());
    }, timeoutMs);
  });
}

module.exports = { discover, RTSP_HINTS };
