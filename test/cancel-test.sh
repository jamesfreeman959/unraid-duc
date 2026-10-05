#!/bin/bash
# Start an index run, cancel it after a few seconds and report the outcome.
S=/usr/local/emhttp/plugins/duc/scripts/duc-index
$S manual &
sleep 4
$S --cancel
sleep 1
php -r 'require "/usr/local/emhttp/plugins/duc/include/common.php"; echo json_encode(duc_status()), "\n";'
echo "leftover processes: $(ps -eo args | grep -E '^(/bin/bash /usr/local/bin/duc|/usr/bin/php -q /usr/local/emhttp|sleep 1$)' | grep -vc 'grep')"
ls /mnt/user/appdata/duc/
tail -2 /var/log/duc-index.log
