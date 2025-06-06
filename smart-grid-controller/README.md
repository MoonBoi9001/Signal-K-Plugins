# Smart Grid Controller for Signal K

[![npm version](https://badge.fury.io/js/smart-grid-controller.svg)](https://www.npmjs.com/package/smart-grid-controller)
[![npm downloads](https://img.shields.io/npm/dw/smart-grid-controller)](https://www.npmjs.com/package/smart-grid-controller)
[![license](https://img.shields.io/npm/l/smart-grid-controller)](https://github.com/MoonBoi9001/signal-k-plugins/blob/main/LICENSE)

Intelligent AC grid management plugin for Victron MultiPlus II systems. Automatically controls when grid power is connected based on battery state, power demand, scheduled charging windows, and comprehensive safety protections.

**📦 Install:** `npm install smart-grid-controller` or via [Signal K App Store](https://www.npmjs.com/package/smart-grid-controller)

## ⚠️ CRITICAL CONFIGURATION WARNING

**This plugin MUST be configured for your specific battery type and capacity before use!** 

Default settings are for Li-NCM 15S (55.5V nominal) batteries. Using wrong voltage thresholds for your battery chemistry could result in:
- Battery damage from over/under voltage
- Fire or explosion risk
- System failure during critical moments

**REQUIRED CONFIGURATION:**
1. **Battery Type**: Select your exact chemistry and cell count
2. **Battery Ah Rating**: Enter your battery's amp-hour capacity (NO DEFAULT - MUST be configured)

**The plugin will NOT start without proper battery configuration.**

## Features

### Four Enable Conditions (grid connects if ANY condition is met)
- **High Load**: AC load >2500W for 3+ seconds (configurable)
- **Low Voltage**: Battery voltage drops below threshold for 3+ seconds (auto-set by battery type)
- **Low Battery**: State of charge <10% for 3+ seconds (configurable)
- **Scheduled Charging**: Configurable time window (default 00:00-06:00 UK time)

### Multi-Layer Battery Protection
- **Standard Protection**: Disconnects at high voltage/SoC (auto-set by battery type, can be overridden by high loads)
- **Emergency Protection**: Immediately disconnects at critical voltage (auto-set by battery type, cannot be overridden)

### Smart Timing
- **3-second delays** prevent false triggers from momentary spikes
- **30-second grace period** before disconnecting when conditions clear
- **Hysteresis thresholds** prevent rapid cycling

## Installation & Configuration

1. **Install Plugin:**
   - **Via Signal K App Store**: Admin UI → AppStore → Electrical → Smart Grid Controller → Install
   - **Via npm**: `npm install smart-grid-controller` 
   - **Package Info**: [View on npm](https://www.npmjs.com/package/smart-grid-controller)
2. **MANDATORY CONFIGURATION**: Configure your battery type AND Ah rating in Signal K admin panel
3. **CRITICAL**: Verify all voltage thresholds match your battery specifications
4. Test in safe conditions with monitoring
5. Wire hardware according to your setup (see Hardware Configuration below)

### Supported Battery Types
- **Li-NCM 4S-15S** (14.8V-55.5V) - High energy density systems with universal cell count support
- **LiFePO4 4S-16S** (12.8V-51.2V) - High voltage LiFePO4 systems with universal cell count support

All configurations use per-cell voltage thresholds automatically scaled to your pack voltage. Simply select your exact battery configuration and the plugin handles the rest safely.

### Configuration Parameters
Access through Signal K admin panel → Plugin Config → Smart Grid Controller:
- **Battery Chemistry**: Select your battery type for automatic safe defaults
- **Battery Capacity**: Enter your battery's Ah rating for accurate charge/discharge detection
- **Load Thresholds**: Customize high-load switching points
- **SoC Limits**: Adjust state-of-charge behavior
- **Schedule Settings**: Modify charging window and timezone

### Battery Capacity Configuration
The plugin calculates your total battery capacity from your Ah rating:

**How It Works:**
- Enter your battery's Ah rating (e.g., 100Ah)
- Plugin automatically calculates total capacity using chemistry and cell count:
  - **Li-NCM**: Uses 3.7V nominal × cells × Ah
  - **LiFePO4**: Uses 3.2V nominal × cells × Ah
- **Example**: 15S NCM × 280Ah = 55.5V × 280Ah = **15.54kWh**

**Charge/Discharge Detection**
- **Charging**: Power in > 1% of calculated battery capacity  
- **Discharging**: Power out > 1% of calculated battery capacity
- **Resting**: Power flow within ±1% of capacity
- **Example**: 15.5kWh battery → ±155W thresholds for charge/discharge detection

This ensures accurate SoC calculations tailored to your exact battery configuration!

## Requirements

- **Option A: MultiPlus II GX** (built-in GX device) - No external hardware needed
- **Option B: Cerbo GX** with VenusOS "Large" firmware + external contactor
- Signal K server with Victron plugin
- **Properly configured battery settings**

## Hardware Configuration

### **Option A: MultiPlus II GX (Recommended)**
```
Grid AC ──► MultiPlus II GX ──► AC Loads
                │
                └─ Built-in GX controls AC input directly
```
- ✅ No external contactor needed
- ✅ Direct AC input enable/disable control
- ✅ Cleaner, more reliable control
- ✅ AC input current limits configured in Victron settings

### **Option B: External Cerbo GX + Contactor**
```
Grid AC ──► [Contactor] ──► MultiPlus II AC Input
              │
              └─ Cerbo GX Relay 1 Output
```
- Requires external contactor wired to Cerbo GX Relay 1
- For systems with separate Cerbo GX units

## Configuration

### **Control Method Settings**
1. **Auto-detect (Recommended)**: Plugin tries both control methods
2. **MultiPlus II GX**: For systems with built-in GX (your setup!)
3. **Cerbo GX**: For external Cerbo GX with relay control

### **For MultiPlus II GX Users:**
- Set **Control Method**: "MultiPlus II GX (built-in GX)"
- No external wiring needed - plugin controls AC input directly
- **AC input current limits**: Configure in Victron system settings (not in this plugin)

## Safety Notes

- **Verify configuration before first use**
- Plugin includes emergency protection but proper configuration is essential
- Test thoroughly in safe conditions with monitoring
- Ensure proper contactor ratings for your system
- Monitor system logs during initial operation
- Have qualified electrical support available

## Troubleshooting

### Plugin Not Working
1. **Check Signal K logs** for error messages from "Smart Grid Controller"
2. **Verify data paths** - ensure Victron plugin is running and data is available:
   - `electrical.chargers.275.voltage` (battery voltage)
   - `electrical.inverters.275.acout.power` (AC load)
   - **MultiPlus II GX**: `electrical.inverters.275.acState.ignoreAcIn1.state` (AC input control)
   - **Cerbo GX**: `electrical.switches.relay1.state` (relay control)
3. **Test control manually** in Signal K admin: Server → Data Browser → navigate to control path

### Common Issues
- **No relay control**: Check Cerbo GX relay configuration and wiring
- **Invalid data warnings**: Verify Victron system is connected and providing data
- **Timezone errors**: Ensure timezone string is valid (e.g., "Europe/London", "America/New_York")
- **Rapid switching**: Adjust hysteresis gaps in configuration
- **Battery protection not triggering at exact threshold**: Update to plugin version 1.2.0+ which fixes boundary condition bug where protection wouldn't trigger when voltage exactly equals the threshold

### Recent Bug Fixes (v2.0.0+)
- **BREAKING CHANGE**: Battery Ah rating now REQUIRED - no defaults for safety
- **MAJOR UPGRADE**: Universal cell count support - NCM 4S-15S and LiFePO4 4S-16S
- **Per-Cell Logic**: All voltage thresholds now calculated from per-cell voltages scaled to pack
- **Safety Improvement**: Control disabled if invalid battery configuration detected
- **Dynamic Battery Capacity**: Configurable battery size (Ah rating) for accurate charge/discharge detection
- **Smart Power Thresholds**: Charge/discharge detection uses 1% of actual battery capacity
- **Contextual SoC**: Voltage-to-SoC calculation now adjusts based on charge/discharge state for better accuracy
- **Power Flow Detection**: Uses charger power data to detect charging, discharging, or resting states
- **Critical Fix**: Battery protection now triggers when voltage exactly equals threshold (was using `>` instead of `>=`)
- **SAFETY FIX**: Time-based charging windows no longer override battery protection (dangerous behavior)
- **Load Override Logic**: Only high-load conditions can override battery protection, not scheduled charging
- **Improved Logging**: Added detailed debug logging to show current system state and protection status
- **Enhanced Monitoring**: Better visibility into which conditions are active and why grid stays on/off

### Upgrading from v1.x
**IMPORTANT**: Version 2.0.0 requires reconfiguration! Existing installations will stop working until you:
1. Configure your battery Ah rating in the plugin settings
2. Verify your battery type and cell count are correct
3. Restart the plugin

### Getting Help
- Check Signal K server logs for detailed error messages
- Verify all configuration parameters are within valid ranges
- Test individual components (relay, voltage readings, load measurements)
- Join Signal K community forums for support

## Version History
- **v1.0.0**: Initial release with Li-NCM 15S and LiFePO4 16S support

## Contributing
Issues and pull requests welcome at the GitHub repository.