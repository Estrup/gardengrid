const noble = require('@abandonware/noble');
const axios = require('axios');

const pushgatewayEndpoint = `${process.env.PUSH_GATEWAY}/metrics/job`
const discoverInterval = 60000 * process.env.DISCOVER_INTERVAL ?? 2;
const discoverTimeout = 1000 * process.env.DISCOVER_TIMEOUT ?? 30;
const flowerInterval = 60000 * process.env.FLOWER_INTERVAL ?? 2
const atcSensorString = process.env.ATC_SENSORS
const atcSensors = atcSensorString.split(';').filter(s => s).map(s => {
    let parts = s.split(',');
    return { id: parts[0], name: parts[1] };
});


const flowerSensorString = process.env.FLOWER_SENSORS
const flowerSensors = flowerSensorString.split(';').filter(s => s).map(s => {
    let parts = s.split(',');
    return { id: parts[0], name: parts[1] };
});

// track what was scanned in the current loop
let scannedInLoop = [];
// found flower peripherals
let flowerPeripherals = [];

/// Wait for the bluetooth hardware to become ready
/// and start scanning for devices
noble.on('stateChange', async function (state) {
    if (state === 'poweredOn') {
        console.log('Started scanning');
        await noble.startScanningAsync();
        setTimeout(async () => {
            console.log('Paused scanning');
            console.log('Scanned in loop', scannedInLoop.map(s => s.name));
            await noble.stopScanningAsync();
        }, discoverTimeout);

        setInterval(async () => {
            console.log('Started scanning')
            scannedInLoop = [];
            await noble.startScanningAsync();
            setTimeout(async () => {
                console.log('Paused scanning')
                console.log('Scanned in loop', scannedInLoop.map(s => s.name));
                await noble.stopScanningAsync();
            }, discoverTimeout);
        }, discoverInterval);

    } else {
        await noble.stopScanningAsync();
    }
});


noble.on('discover', async (peripheral) => {
    try {
        // if (peripheral.advertisement?.localName)
        //     console.log('peripheral: ', peripheral.advertisement?.localName);
        if (peripheral.advertisement?.localName?.startsWith("ATC")) {
            await handleATCSensor(peripheral);
        }

        if (peripheral.advertisement.localName === 'Flower care') {
            if (flowerPeripherals.findIndex(p => p.id == peripheral.id) !== -1) {
                return;
            }
            flowerPeripherals.push(peripheral);
            const sensor = flowerSensors.find(sensor => sensor.id === peripheral.uuid);
            if (sensor) {
                // console.log('Mi Flora sensor found');
                // console.log('peripheral with UUID ' + peripheral.uuid + ' found');
                // console.log('peripheral rssi value: ' + peripheral.rssi);
                sensor.rssi = peripheral.rssi;
                try { await connectToMiFlora(peripheral, sensor); }
                catch (e) {
                    console.error(e);
                    flowerPeripherals.splice(flowerPeripherals.indexOf(peripheral), 1);
                }
            }
            else {
                console.warn('Sensor not found', peripheral.id)
            }
        }
        // else
        //     console.log('peripheral discovered (' + peripheral.advertisement.localName + ')');
    }
    catch (e) {
        console.error(e);
        process.exit(1);
    }
});


async function handleATCSensor(peripheral) {
    if (peripheral.advertisement.serviceData.length > 0) {
        const data = parseATCManufacturerData(peripheral.advertisement.serviceData[0].data, peripheral.advertisement?.localName);
        //console.log('Name:', data.name, 'Temperature:', data.temperature, 'Humidity:', data.humidity, 'Battery:', data.batteryPercent);

        const sensor = atcSensors.find(sensor => sensor.id === peripheral.uuid);
        if (sensor) {

            const metrics = `mi_temperature{sensor="${sensor.name}"} ${data.temperature}\n` +
                `mi_humidity{sensor="${sensor.name}"} ${data.humidity}\n` +
                `mi_battery{sensor="${sensor.name}"} ${data.batteryPercent}\n`
                ;

            console.log(`Metrics for ${sensor.name}:\n`, metrics);

            //Send the metrics to the Pushgateway
            axios.post(`${pushgatewayEndpoint}/${sensor.name}`, metrics, { headers: { 'Content-Type': 'text/plain' } })
                .then(() => console.log('Metrics pushed successfully\n====================='))
                .catch((error) => console.error('Error pushing metrics', error));

            //Just track what ws scanned in this loop
            scannedInLoop.push(sensor);
        }
        else {
            console.warn('Sensor not found', peripheral.id)
        }
    }
    else
        console.warn('peripheral with localName ' + peripheral.advertisement?.localName + ' found - but no data in serviceData');
}

async function connectToMiFlora(peripheral, sensor) {
    await peripheral.connectAsync();
    setInterval(async () => {
        try {
            await peripheral.connectAsync();
            await handleMifloraConnection(peripheral, sensor);
        }
        catch (e) {
            console.error(e);
            flowerPeripherals.splice(flowerPeripherals.indexOf(peripheral), 1);
        }

    }, flowerInterval);
}

async function handleMifloraConnection(peripheral, sensor) {
    const serviceUUIDs = [cleanUUID('00001204-0000-1000-8000-00805f9b34fb')];
    const characteristicUUIDs = [
        cleanUUID('00001a00-0000-1000-8000-00805f9b34fb'),
        cleanUUID('00001a01-0000-1000-8000-00805f9b34fb'),
        cleanUUID('00001a02-0000-1000-8000-00805f9b34fb') //battery
    ];

    const { services, characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        serviceUUIDs,
        characteristicUUIDs
    );
    const modeChangeCharacteristic = characteristics[0];
    const dataCharacteristic = characteristics[1];
    const batteryCharacteristic = characteristics[2];
    const command = Buffer.from([0xA0, 0x1F]); // this will depend on the specific command required by the device
    modeChangeCharacteristic.write(command, false, async (error) => {
        if (error) {
            console.log('Error writing to mode change characteristic', error);
            return;
        }

        // Read battery level
        const batteryData = await batteryCharacteristic.readAsync();
        const batteryLevel = batteryData.readUInt8(0);
        console.log('Battery Level:', batteryLevel);

        dataCharacteristic.read(async (error, data) => {
            if (error) {
                console.log('Error reading data characteristic', error);
                return;
            }

            const temperature = data.readInt16LE(0) / 10;
            const lux = data.readUInt32LE(3);
            const moisture = data.readUInt8(7);
            const fertility = data.readUInt16LE(8);

            peripheral.disconnect();

            // Create a string with the metrics in the Prometheus exposition format
            const metrics = `mi_flora_temperature{sensor="${sensor.name}"} ${temperature}\n` +
                `mi_flora_lux{sensor="${sensor.name}"} ${lux}\n` +
                `mi_flora_moisture{sensor="${sensor.name}"} ${moisture}\n` +
                `mi_flora_fertility{sensor="${sensor.name}"} ${fertility}\n` +
                `mi_flora_rssi{sensor="${sensor.name}"} ${sensor.rssi}\n` +
                `mi_flora_battery{sensor="${sensor.name}"} ${batteryLevel}\n`;

            console.log('Metrics:', metrics);
            // Send the metrics to the Pushgateway
            axios.post(`${pushgatewayEndpoint}/${sensor.name}`, metrics, { headers: { 'Content-Type': 'text/plain' } })
                .then(() => console.log('Metrics pushed successfully\n ====================='))
                .catch((error) => console.error('Error pushing metrics', error));
            //Just track what ws scanned in this loop
            scannedInLoop.push(sensor);
        });
    });
}

//
// Parse the manufacturer data from the Mi Temperature and Humidity sensor
// with custom firmware
function parseATCManufacturerData(data, name) {
    if (data.length == 15)
        return {
            temperature: data.readInt16LE(6) * 0.01,
            humidity: data.readUInt16LE(8) * 0.01,
            batteryPercent: data.readUInt8(12),
            name: name
        };
    else {
        let mac = [];
        for (let i = 0; i < 6; i++) {
            mac.unshift(data.readUInt8(i).toString(16).padStart(2, '0'));
        }
        mac = mac.join(':');
        return {
            mac: mac,
            temperature: data.readIntBE(6, 2) / 10.0,
            humidity: data.readUInt8(8),
            batteryPercent: data.readUInt8(9),
            name: name
        };
    }
}

/// Some OS' (e.g. Linux) don't support the full UUID, so we need to clean it up
function cleanUUID(uuid) {
    if (process.platform === 'linux')
        return uuid.replace(/-/g, '').toLowerCase();

    return uuid.toLowerCase();
}