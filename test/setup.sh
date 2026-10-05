#!/bin/bash
# Lay out a fake Unraid system inside a container and install the package.
set -e
apt-get -qq update >/dev/null && apt-get -qq install -y xz-utils util-linux procps >/dev/null
tar xJf /dist/unraid-duc-*.txz -C /
ln -sf /usr/local/bin/php /usr/bin/php
mkdir -p /usr/local/sbin /usr/local/emhttp/webGui/scripts /boot/config/plugins/duc /var/log/plugins
touch /var/log/plugins/duc.plg
cat > /usr/local/sbin/update_cron <<'X'
#!/bin/bash
echo "[update_cron]"; cat /boot/config/plugins/duc/*.cron 2>/dev/null
X
cat > /usr/local/emhttp/webGui/scripts/notify <<'X'
#!/bin/bash
echo "notify $*" >> /tmp/notify.log
X
chmod +x /usr/local/sbin/update_cron /usr/local/emhttp/webGui/scripts/notify

# sample shares
mkdir -p /mnt/user/appdata /mnt/user/media/{movies,tv/"Show One"/S01,music} /mnt/user/backups/{laptop,phone} /mnt/user/isos "/mnt/user/Weird <img src=x onerror=alert(1)>"
mk() { head -c "$2" /dev/zero > "$1"; }
for i in $(seq 1 6); do mk "/mnt/user/media/movies/Movie $i.mkv" $((i*9000000)); done
for i in $(seq 1 10); do mk "/mnt/user/media/tv/Show One/S01/E$i.mkv" 4000000; done
for i in $(seq 1 40); do mk "/mnt/user/media/music/track$i.flac" 500000; done
mk /mnt/user/backups/laptop/full.img 30000000; mk /mnt/user/backups/phone/photos.tar 12000000
mk /mnt/user/isos/debian.iso 25000000
mk "/mnt/user/Weird <img src=x onerror=alert(1)>/q\"uote's.txt" 3000000
mkdir -p /mnt/disk1 && mk /mnt/disk1/onlyondisk.bin 5000000
