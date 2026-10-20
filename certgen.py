"""Erzeugt ein selbstsigniertes TLS-Zertifikat in reinem Python (ohne OpenSSL-Programm
oder Zusatzpakete), damit Lernquest auch per https:// erreichbar ist.

Erfüllt Apples Anforderungen an Server-Zertifikate: RSA 2048, SHA-256,
Subject Alternative Name, Extended Key Usage serverAuth, Laufzeit unter 825 Tagen.
"""

import base64
import datetime
import hashlib
import ipaddress
import math
import secrets

# ---------- minimaler DER-Encoder ----------

def _len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def tlv(tag, content):
    return bytes([tag]) + _len(len(content)) + content


def seq(*items):
    return tlv(0x30, b"".join(items))


def set_(*items):
    return tlv(0x31, b"".join(items))


def integer(v):
    return tlv(0x02, v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big"))


def oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    body = bytes([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        enc = [p & 0x7F]
        p >>= 7
        while p:
            enc.append(0x80 | (p & 0x7F))
            p >>= 7
        body += bytes(reversed(enc))
    return tlv(0x06, body)


NULL = b"\x05\x00"


def bitstring(b, unused=0):
    return tlv(0x03, bytes([unused]) + b)


def octets(b):
    return tlv(0x04, b)


def boolean(v):
    return tlv(0x01, b"\xff" if v else b"\x00")


def utf8(s):
    return tlv(0x0C, s.encode("utf-8"))


def utctime(dt):
    return tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode())


def explicit(n, content):
    return tlv(0xA0 + n, content)


def pem(label, der):
    b64 = base64.b64encode(der).decode()
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


# ---------- RSA ----------

_SMALL_PRIMES = [p for p in range(3, 2000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


def _probable_prime(n, rounds=40):
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits, e):
    while True:
        c = secrets.randbits(bits) | (3 << (bits - 2)) | 1  # obere zwei Bits gesetzt -> n hat volle Länge
        if math.gcd(e, c - 1) == 1 and _probable_prime(c):
            return c


def rsa_key(bits=2048, e=65537):
    while True:
        p, q = _prime(bits // 2, e), _prime(bits // 2, e)
        if p != q:
            break
    n, d = p * q, pow(e, -1, (p - 1) * (q - 1))
    return {"n": n, "e": e, "d": d, "p": p, "q": q}


def _sign_sha256(k, data):
    size = (k["n"].bit_length() + 7) // 8
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(data).digest()
    em = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(em, "big"), k["d"], k["n"]).to_bytes(size, "big")


# ---------- Zertifikat ----------

def generate(ips, dns_names=("localhost",), days=820, common_name="Lernquest (lokal)"):
    """Gibt (cert_pem, key_pem, cert_der) zurück."""
    k = rsa_key()
    sha256rsa = seq(oid("1.2.840.113549.1.1.11"), NULL)
    name = seq(set_(seq(oid("2.5.4.3"), utf8(common_name))))
    now = datetime.datetime.now(datetime.timezone.utc)
    validity = seq(utctime(now - datetime.timedelta(days=1)), utctime(now + datetime.timedelta(days=days)))
    pub = seq(integer(k["n"]), integer(k["e"]))
    spki = seq(seq(oid("1.2.840.113549.1.1.1"), NULL), bitstring(pub))

    san = [tlv(0x82, d.encode()) for d in dns_names]
    san += [tlv(0x87, ipaddress.ip_address(ip).packed) for ip in ips]
    extensions = explicit(3, seq(
        seq(oid("2.5.29.19"), boolean(True), octets(seq(boolean(True)))),          # basicConstraints: CA
        seq(oid("2.5.29.15"), boolean(True), octets(bitstring(b"\xa4", unused=2))),  # keyUsage
        seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))),               # extKeyUsage: serverAuth
        seq(oid("2.5.29.14"), octets(octets(hashlib.sha1(pub).digest()))),          # subjectKeyIdentifier
        seq(oid("2.5.29.17"), octets(seq(*san))),                                   # subjectAltName
    ))

    tbs = seq(explicit(0, integer(2)), integer(secrets.randbits(63) | 1), sha256rsa,
              name, validity, name, spki, extensions)
    cert_der = seq(tbs, sha256rsa, bitstring(_sign_sha256(k, tbs)))
    key_der = seq(integer(0), integer(k["n"]), integer(k["e"]), integer(k["d"]), integer(k["p"]),
                  integer(k["q"]), integer(k["d"] % (k["p"] - 1)), integer(k["d"] % (k["q"] - 1)),
                  integer(pow(k["q"], -1, k["p"])))
    return pem("CERTIFICATE", cert_der), pem("RSA PRIVATE KEY", key_der), cert_der
