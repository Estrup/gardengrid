const noble = require('@abandonware/noble');

noble.on('stateChange', async function (state) {
    if (state === 'poweredOn') {

        await noble.startScanningAsync();

    } else {
        await noble.stopScanningAsync();
    }
});


noble.on('discover', async (peripheral) => {
    try {

        if (peripheral.advertisement?.localName?.startsWith("ATC")) {
            console.log('ATC Sensor found');
            console.log('peripheral: ', peripheral.advertisement?.localName);
            console.log('id: ', peripheral.id);
            console.log('uuid: ', peripheral.id);
            console.log('address: ', peripheral.id);
        }

        if (peripheral.advertisement.localName === 'Flower care') {
            console.log('Flower care Sensor found');
            console.log('peripheral: ', peripheral.advertisement?.localName);
            console.log('id: ', peripheral.id);
            console.log('uuid: ', peripheral.id);
            console.log('address: ', peripheral.id);
        }

    }
    catch (e) {
        console.error(e);
    }
});
