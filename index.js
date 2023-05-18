const noble = require('@abandonware/noble');
const axios = require('axios');

const pushgatewayEndpoint = 'http://192.168.0.112:9091/metrics/job'
const checkInterval = 60000 * 1; // 1 minute

const sensors = [
    {
        id: 'c4:7c:8d:6d:b3:73',
        name: 'miflora_sensor_x',
        rssi: 0
    },
    {
        id: 'c4:7c:8d:6d:a4:05',
        name: 'miflora_sensor_o',
        rssi: 0
    }
]

const miSensors = [
    {
        network_name: 'ATC_9FA955',
        name: 'mi_out',
    },
    {
        network_name: 'ATC_F3BFE6',
        name: 'mi_in',
    }
]

noble.on('discover', async (peripheral) => {
    try {
        if (peripheral.advertisement?.localName?.startsWith("ATC")) {
            if (peripheral.advertisement.serviceData.length > 0) {
                const data = parseATCManufacturerData(peripheral.advertisement.serviceData[0].data, peripheral.advertisement?.localName);
                console.log('Name:', data.name, 'Temperature:', data.temperature, 'Humidity:', data.humidity, 'Battery:', data.batteryPercent);

                const sensor = miSensors.find(sensor => sensor.network_name === peripheral.advertisement?.localName);
                if (sensor) {

                    const metrics = `mi_temperature{sensor="${sensor.name}"} ${data.temperature}\n` +
                        `mi_humidity{sensor="${sensor.name}"} ${data.humidity}\n` +
                        `mi_battery{sensor="${sensor.name}"} ${data.batteryPercent}\n`
                        ;

                    console.log('Metrics:', metrics);

                    //Send the metrics to the Pushgateway
                    axios.post(`${pushgatewayEndpoint}/${sensor.name}`, metrics, { headers: { 'Content-Type': 'text/plain' } })
                        .then(() => console.log('Metrics pushed successfully'))
                        .catch((error) => console.error('Error pushing metrics', error));
                }
                else {
                    console.warn('Sensor not found', peripheral.id)
                }
            }
            else
                console.log('peripheral with UUID ' + peripheral.uuid + ' found - but no data');
        }

        if (peripheral.advertisement.localName === 'Flower care') {
            console.log('peripheral.address', peripheral.address)
            const sensor = sensors.find(sensor => sensor.id === peripheral.address);
            if (sensor) {
                console.log('Mi Flora sensor found');
                console.log('peripheral with UUID ' + peripheral.uuid + ' found');
                console.log('peripheral rssi value: ' + peripheral.rssi);
                sensor.rssi = peripheral.rssi;
                connectAndSetUp(peripheral, sensor);
            }
        }
        // else
        //     console.log('peripheral discovered (' + peripheral.advertisement.localName + ')');
    }
    catch (e) {
        console.error(e);
    }
});

noble.on('stateChange', function (state) {
    if (state === 'poweredOn') {
        console.log('Started scanning')
        noble.startScanningAsync();
        setInterval(() => {
            console.log('Started scanning')
            noble.startScanningAsync();
            setTimeout(() => {
                console.log('Paused scanning')
                noble.stopScanningAsync();
            }, 25000);
        }, checkInterval);

    } else {
        noble.stopScanningAsync();
    }
});

function connectAndSetUp(peripheral, sensor) {
    peripheral.connect(async (error) => {
        const serviceUUIDs = ['0000120400001000800000805f9b34fb'];
        const characteristicUUIDs = [
            '00001a0000001000800000805f9b34fb', //mode
            '00001a0100001000800000805f9b34fb', //data
            '00001a0200001000800000805f9b34fb' //battery
        ];

        peripheral.discoverSomeServicesAndCharacteristics(
            serviceUUIDs,
            characteristicUUIDs,
            onServicesAndCharacteristicsDiscovered.bind(null, sensor, peripheral)
        );        
    });
}

function onServicesAndCharacteristicsDiscovered(sensor, peripheral, error, c, characteristics) {
    const modeChangeCharacteristic = characteristics[0];
    const dataCharacteristic = characteristics[1];
    const batteryCharacteristic = characteristics[2]
    const command = Buffer.from([0xA0, 0x1F]); // this will depend on the specific command required by the device

    modeChangeCharacteristic.write(command, false, async (error) => {
        if (error) {
            console.log('Error writing to mode change characteristic', error);
            return;
        }

        // Read battery level
        const batteryData = await batteryCharacteristic.readAsync()
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

            console.log('Temperature:', temperature);
            console.log('Lux:', lux);
            console.log('Moisture:', moisture);
            console.log('Fertility:', fertility);

            peripheral.disconnect();

            // Create a string with the metrics in the Prometheus exposition format
            const metrics = `mi_flora_temperature{sensor="${sensor.name}"} ${temperature}\n` +
                `mi_flora_lux{sensor="${sensor.name}"} ${lux}\n` +
                `mi_flora_moisture{sensor="${sensor.name}"} ${moisture}\n` +
                `mi_flora_fertility{sensor="${sensor.name}"} ${fertility}\n` +
                `mi_flora_rssi{sensor="${sensor.name}"} ${sensor.rssi}\n` +
                `mi_flora_battery{sensor="${sensor.name}"} ${batteryLevel}\n`
                ;

            console.log('Metrics:', metrics);
            // Send the metrics to the Pushgateway
            axios.post(`${pushgatewayEndpoint}/${sensor.name}`, metrics, { headers: { 'Content-Type': 'text/plain' } })
                .then(() => console.log('Metrics pushed successfully'))
                .catch((error) => console.error('Error pushing metrics', error));
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
        console.log('mac:', mac);
        return {
            mac: mac,
            temperature: data.readIntBE(6, 2) / 10.0,
            humidity: data.readUInt8(8),
            batteryPercent: data.readUInt8(9),
            name: name
        };
    }
}