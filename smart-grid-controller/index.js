/**
 * Signal K Smart Grid Controller Plugin
 * 
 * PURPOSE:
 * Intelligently controls when grid AC power is allowed to flow to your Victron MultiPlus II.
 * This plugin acts as an automated grid management system that decides when to connect/disconnect
 * grid power based on battery state, power demand, time scheduling, and multiple safety protections.
 * 
 * HOW IT WORKS:
 * The plugin monitors your battery voltage, AC load, and time, then controls a relay (virtual switch)
 * that enables/disables grid AC input to your MultiPlus. It reads data from your Victron system
 * via Signal K and sends control commands back through the Cerbo GX.
 * 
 * FOUR ENABLE CONDITIONS (Grid turns ON if ANY condition is met):
 * 
 * 1. HIGH LOAD CONDITION
 *    - Enables when: AC load > 2500W for 3+ seconds 
 *    - Disables when: AC load drops below 1750W
 *    - Purpose: Allows grid to help with high power demands (heat pumps, electric vehicles, etc.)
 *    - Hysteresis gap: 750W (2500W↔1750W) prevents rapid switching
 * 
 * 2. LOW VOLTAGE CONDITION  
 *    - Enables when: DC voltage < 50.83V for 3+ seconds
 *    - Disables when: DC voltage rises above 53.1V
 *    - Purpose: Prevents battery from going too low (around 10% SoC)
 *    - Hysteresis gap: 2.27V prevents rapid switching (around 30% SoC)
 * 
 * 3. LOW STATE OF CHARGE CONDITION
 *    - Enables when: Battery SoC < 10% for 3+ seconds  
 *    - Disables when: Battery SoC rises above 30%
 *    - Purpose: Backup protection based on calculated state of charge
 *    - Hysteresis gap: 20% prevents rapid switching
 * 
 * 4. SCHEDULED CHARGING WINDOW
 *    - Enables when: UK time between 00:00 and 06:00
 *    - Disables when: Outside this time window
 *    - Purpose: Allows cheap overnight charging during off-peak electricity rates
 *    - No delay: Immediate enable/disable at time boundaries
 * 
 * BATTERY PROTECTION LAYERS:
 * 
 * STANDARD PROTECTION (Can be overridden by high loads only):
 *    - Triggers when: Voltage >= 61.5V OR SoC >= 95%
 *    - Clears when: Voltage < 60.75V AND SoC < 92.5% (0.75V/2.5% hysteresis)
 *    - Override: ONLY high load condition (>2500W) can keep grid on
 *    - Blocked: Time-based charging CANNOT override (safety improvement)
 *    - Purpose: Prevents routine overcharging while allowing critical loads
 * 
 * EMERGENCY PROTECTION (Cannot be overridden):
 *    - Triggers when: Voltage >= 63.0V
 *    - Clears when: Voltage < 62.25V (0.75V hysteresis)
 *    - Override: NONE - immediately disconnects grid regardless of load or time
 *    - Purpose: Final safety protection against battery damage
 * 
 * TIMING BEHAVIOR:
 * 
 * Enable Delays (prevents false triggers):
 *    - Load, voltage, SoC conditions: 3 seconds
 *    - Time condition: Immediate
 *    - Purpose: Avoids reacting to momentary spikes/dips in readings
 * 
 * Disable Delays:
 *    - Normal conditions: 30 seconds after ALL conditions clear
 *    - Battery protection: Immediate when triggered  
 *    - Emergency protection: Immediate when triggered
 *    - Purpose: Provides stability, prevents rapid cycling
 * 
 * Startup Behavior:
 *    - Grid enabled immediately on plugin start
 *    - 30-second grace period before normal evaluation begins
 *    - Purpose: Ensures reliable operation during system restarts
 * 
 * HYSTERESIS EXPLANATION:
 * Hysteresis means different thresholds for turning ON vs turning OFF.
 * Example: Load enables at 2500W but disables at 1750W.
 * This prevents rapid on/off cycling when readings hover near a single threshold.
 * 
 * BATTERY CONFIGURATION:
 * Universal cell-count support for multiple battery configurations:
 * - Li-NCM: 4S to 15S configurations supported (14.8V to 55.5V nominal)
 * - LiFePO4: 4S to 16S configurations supported (12.8V to 51.2V nominal)
 * - Per-cell voltage thresholds automatically scaled to pack voltage
 * - Chemistry-specific SoC curves calculated from per-cell voltage
 * - Safe defaults: Control disabled if invalid configuration detected
 * 
 * HARDWARE CONNECTIONS:
 * - Reads from: electrical.chargers.275.voltage (DC voltage)
 * - Reads from: electrical.inverters.275.acout.power (AC load)  
 * - Controls (MultiPlus II GX): electrical.inverters.275.acState.ignoreAcIn1.state
 * - Controls (Cerbo GX): electrical.switches.relay1.state (grid AC enable/disable)
 * - Maps to: com.victronenergy.vebus.ttyS3 (MultiPlus II GX) or com.victronenergy.system /Relay/1/State (Cerbo GX)
 */

module.exports = function smartGridController(app) {
    // Logging helper with consistent formatting
    function log(level, message, data = {}) {
      const timestamp = new Date().toISOString();
      const prefix = 'Smart Grid Controller';
      if (Object.keys(data).length > 0) {
        console[level](`[${timestamp}] ${prefix}: ${message}`, data);
      } else {
        console[level](`[${timestamp}] ${prefix}: ${message}`);
      }
    }

    // Start with grid enabled on startup
    let gridState = true;
    
    // Track which conditions are currently active
    let enabledByLoad = false;
    let enabledByVoltage = false; 
    let enabledBySoC = false;
    let enabledByTime = false;
    
    // Track battery protection state
    let batteryProtectionActive = false;
    
    // Track emergency battery protection (cannot be overridden)
    let emergencyProtectionActive = false;
    
    // Timers for condition evaluation
    let loadEnableTimer = null;
    let voltageEnableTimer = null;
    let socEnableTimer = null;
    
    // Timer for relay disable delay
    let disableTimer = null;
    
    // Startup grace period
    let startupGraceTimer = null;

    // Debug logging timer
    let debugTimer = null;
    let lastGridState = true;
    let debugCounter = 0;

    // Function to log system state for debugging
    function logSystemState(voltage, soc, load, config, chargePower, reason = '') {
      const activeConditions = [];
      if (enabledByLoad) activeConditions.push('Load');
      if (enabledByVoltage) activeConditions.push('Voltage');
      if (enabledBySoC) activeConditions.push('SoC');
      if (enabledByTime) activeConditions.push('Time');
      
      const protections = [];
      if (batteryProtectionActive) protections.push('Battery');
      if (emergencyProtectionActive) protections.push('Emergency');
      
      // Determine charge state for logging using dynamic threshold
      const threshold = config.onePercentThresholdW;
      const chargeState = chargePower > threshold ? 'Charging' : 
                         chargePower < -threshold ? 'Discharging' : 
                         'Resting';
      
      log('debug', `System State${reason ? ` (${reason})` : ''}: Grid=${gridState ? 'ON' : 'OFF'} | Conditions=[${activeConditions.join(',')}] | Protections=[${protections.join(',')}] | V=${voltage.toFixed(2)}V | SoC=${soc.toFixed(1)}% | Load=${load.toFixed(0)}W | Charge=${chargePower.toFixed(0)}W(${chargeState}) | Battery=${config.batteryCapacityKwh.toFixed(1)}kWh`);
    }

    // Get plugin configuration with defaults
    function getConfig() {
      const config = app.readPluginOptions();
      
      // Parse battery type to get chemistry and cell count
      const batteryType = config.batteryType || 'li-ncm-15s';
      const [chemistry, cellCountStr] = batteryType.split('-');
      const cellCount = parseInt(cellCountStr.replace('s', ''));
      
      // Per-cell voltage thresholds for each chemistry
      let perCellVoltages = {};
      switch (chemistry) {
        case 'li-ncm':
          perCellVoltages = {
            lowVoltageEnable: 3.39,    // ~10% SoC per cell
            lowVoltageDisable: 3.54,   // ~30% SoC per cell
            highVoltageProtection: 4.1, // ~95% SoC per cell
            emergencyVoltage: 4.2      // ~100% SoC per cell
          };
          break;
        case 'lifepo4':
          perCellVoltages = {
            lowVoltageEnable: 3.0,     // ~3.6% SoC per cell
            lowVoltageDisable: 3.25,   // ~14.22% SoC per cell
            highVoltageProtection: 3.45, // ~97.5% SoC per cell
            emergencyVoltage: 3.65     // ~100% SoC per cell
          };
          break;
        default:
          log('error', `Unknown battery chemistry: ${chemistry}`);
          return null;
      }
      
      // Calculate pack voltages by multiplying per-cell voltages by cell count
      const packVoltages = {
        lowVoltageEnable: perCellVoltages.lowVoltageEnable * cellCount,
        lowVoltageDisable: perCellVoltages.lowVoltageDisable * cellCount,
        highVoltageProtection: perCellVoltages.highVoltageProtection * cellCount,
        emergencyVoltage: perCellVoltages.emergencyVoltage * cellCount
      };

      // Calculate battery capacity and 1% power threshold
      const batteryAh = config.batteryCapacity?.batteryAh;
      
      // Safety check - battery Ah MUST be configured
      if (!batteryAh || batteryAh <= 0) {
        log('error', 'Battery Ah rating not configured - MUST be set in plugin configuration before use');
        return null;
      }
      
      const nominalCellVoltage = chemistry === 'lifepo4' ? 3.2 : 3.7; // LiFePO4: 3.2V, Li-NCM: 3.7V
      const nominalPackVoltage = nominalCellVoltage * cellCount;
      const batteryCapacityKwh = (nominalPackVoltage * batteryAh) / 1000; // Convert Wh to kWh
      
      // Calculate 1% power threshold (for charge/discharge detection)
      const onePercentThresholdW = (batteryCapacityKwh * 1000) * 0.01; // 1% of capacity in watts

      const finalConfig = {
        batteryType: batteryType,
        chemistry: chemistry,
        cellCount: cellCount,
        batteryCapacityKwh: batteryCapacityKwh,
        onePercentThresholdW: onePercentThresholdW,
        loadThresholds: {
          enableWatts: config.loadThresholds?.enableWatts || 2500,
          disableWatts: config.loadThresholds?.disableWatts || 1750
        },
        voltageThresholds: packVoltages,
        socThresholds: {
          lowSocEnable: config.socThresholds?.lowSocEnable || 10,
          lowSocDisable: config.socThresholds?.lowSocDisable || 30,
          highSocProtection: config.socThresholds?.highSocProtection || 95
        },
        scheduleSettings: {
          timezone: config.scheduleSettings?.timezone || 'Europe/London',
          startHour: config.scheduleSettings?.startHour || 0,
          endHour: config.scheduleSettings?.endHour || 6
        },
        controlMethod: config.controlMethod || 'auto'
      };

      // Validate configuration for safety
      if (finalConfig.loadThresholds.enableWatts <= finalConfig.loadThresholds.disableWatts) {
        log('warn', `Invalid load thresholds - enable (${finalConfig.loadThresholds.enableWatts}W) must be > disable (${finalConfig.loadThresholds.disableWatts}W), using defaults`);
        finalConfig.loadThresholds.enableWatts = 2500;
        finalConfig.loadThresholds.disableWatts = 1750;
      }
      
      if (finalConfig.socThresholds.lowSocEnable >= finalConfig.socThresholds.lowSocDisable) {
        log('warn', `Invalid SoC thresholds - enable (${finalConfig.socThresholds.lowSocEnable}%) must be < disable (${finalConfig.socThresholds.lowSocDisable}%), using defaults`);
        finalConfig.socThresholds.lowSocEnable = 10;
        finalConfig.socThresholds.lowSocDisable = 30;
      }
      
      if (finalConfig.voltageThresholds.lowVoltageEnable >= finalConfig.voltageThresholds.lowVoltageDisable) {
        log('warn', 'Invalid voltage thresholds detected, using battery defaults');
        finalConfig.voltageThresholds = packVoltages;
      }

      return finalConfig;
    }

    // Calculate SoC from voltage based on battery type, cell count, and charging state
    function calculateSoC(packVoltage, chemistry, cellCount, chargePower, powerThreshold) {
      // Calculate per-cell voltage
      const cellVoltage = packVoltage / cellCount;
      
      // Detect battery state based on power flow (using dynamic threshold based on battery capacity)
      const isCharging = chargePower > powerThreshold; // Charging if charger power > 1% of battery capacity
      const isDischarging = chargePower < -powerThreshold; // Discharging if power out > 1% of capacity
      const isResting = chargePower >= -powerThreshold && chargePower <= powerThreshold; // Resting if power flow within ±1%
      
      // Apply voltage offset based on state (charge/discharge hysteresis)
      let adjustedCellVoltage = cellVoltage;
      if (chemistry === 'lifepo4') {
        if (isCharging) {
          adjustedCellVoltage = cellVoltage - 0.1; // Charging curve is ~0.1V higher than rest
        } else if (isDischarging) {
          adjustedCellVoltage = cellVoltage + 0.05; // Discharge curve is ~0.05V lower than rest
        }
        // For resting, use voltage as-is
      } else if (chemistry === 'li-ncm') {
        if (isCharging) {
          adjustedCellVoltage = cellVoltage - 0.05; // NCM has smaller hysteresis
        } else if (isDischarging) {
          adjustedCellVoltage = cellVoltage + 0.03;
        }
      }
      
      switch (chemistry) {
        case 'li-ncm':
          // Li-NCM per-cell SoC calculation (3.0V-4.2V range) - adjusted for charge/discharge state
          if (adjustedCellVoltage >= 4.2) return 100;
          else if (adjustedCellVoltage >= 4.0) return 90 + ((adjustedCellVoltage - 4.0) / (4.2 - 4.0)) * 10; // 90-100%
          else if (adjustedCellVoltage >= 3.87) return 80 + ((adjustedCellVoltage - 3.87) / (4.0 - 3.87)) * 10; // 80-90%
          else if (adjustedCellVoltage >= 3.78) return 70 + ((adjustedCellVoltage - 3.78) / (3.87 - 3.78)) * 10; // 70-80%
          else if (adjustedCellVoltage >= 3.7) return 60 + ((adjustedCellVoltage - 3.7) / (3.78 - 3.7)) * 10; // 60-70%
          else if (adjustedCellVoltage >= 3.63) return 50 + ((adjustedCellVoltage - 3.63) / (3.7 - 3.63)) * 10; // 50-60%
          else if (adjustedCellVoltage >= 3.58) return 40 + ((adjustedCellVoltage - 3.58) / (3.63 - 3.58)) * 10; // 40-50%
          else if (adjustedCellVoltage >= 3.54) return 30 + ((adjustedCellVoltage - 3.54) / (3.58 - 3.54)) * 10; // 30-40%
          else if (adjustedCellVoltage >= 3.48) return 20 + ((adjustedCellVoltage - 3.48) / (3.54 - 3.48)) * 10; // 20-30%
          else if (adjustedCellVoltage >= 3.39) return 10 + ((adjustedCellVoltage - 3.39) / (3.48 - 3.39)) * 10; // 10-20%
          else if (adjustedCellVoltage >= 3.0) return 0 + ((adjustedCellVoltage - 3.0) / (3.39 - 3.0)) * 10; // 0-10%
          else return 0;

        case 'lifepo4':
          // LiFePO4 per-cell SoC calculation (3.0V-3.65V range) - adjusted for charge/discharge state
          if (adjustedCellVoltage >= 3.65) return 100;        // 3.65V per cell - full charge
          else if (adjustedCellVoltage >= 3.4) return 97.5 + ((adjustedCellVoltage - 3.4) / (3.65 - 3.4)) * 2.5;   // 97.5-100%
          else if (adjustedCellVoltage >= 3.381) return 92.7 + ((adjustedCellVoltage - 3.381) / (3.4 - 3.381)) * 4.8; // 92.7-97.5%
          else if (adjustedCellVoltage >= 3.325) return 27.3 + ((adjustedCellVoltage - 3.325) / (3.381 - 3.325)) * 65.4;   // 27.3-92.7%
          else if (adjustedCellVoltage >= 3.2) return 5.5 + ((adjustedCellVoltage - 3.2) / (3.325 - 3.2)) * 21.8;     // 5.5-27.3%
          else if (adjustedCellVoltage >= 3.188) return 9.0 + ((adjustedCellVoltage - 3.188) / (3.2 - 3.188)) * -3.5; // 9-5.5%
          else if (adjustedCellVoltage >= 3.1) return 3.6 + ((adjustedCellVoltage - 3.1) / (3.188 - 3.1)) * 5.4;    // 3.6-9%
          else if (adjustedCellVoltage >= 3.0) return 0 + ((adjustedCellVoltage - 3.0) / (3.1 - 3.0)) * 3.6;        // 0-3.6%
          else return 0;

        default:
          // Fallback to Li-NCM calculation if chemistry not recognized
          if (adjustedCellVoltage >= 4.2) return 100;
          else if (adjustedCellVoltage >= 4.0) return 90 + ((adjustedCellVoltage - 4.0) / (4.2 - 4.0)) * 10;
          else if (adjustedCellVoltage >= 3.87) return 80 + ((adjustedCellVoltage - 3.87) / (4.0 - 3.87)) * 10;
          else if (adjustedCellVoltage >= 3.78) return 70 + ((adjustedCellVoltage - 3.78) / (3.87 - 3.78)) * 10;
          else if (adjustedCellVoltage >= 3.7) return 60 + ((adjustedCellVoltage - 3.7) / (3.78 - 3.7)) * 10;
          else if (adjustedCellVoltage >= 3.63) return 50 + ((adjustedCellVoltage - 3.63) / (3.7 - 3.63)) * 10;
          else if (adjustedCellVoltage >= 3.58) return 40 + ((adjustedCellVoltage - 3.58) / (3.63 - 3.58)) * 10;
          else if (adjustedCellVoltage >= 3.54) return 30 + ((adjustedCellVoltage - 3.54) / (3.58 - 3.54)) * 10;
          else if (adjustedCellVoltage >= 3.48) return 20 + ((adjustedCellVoltage - 3.48) / (3.54 - 3.48)) * 10;
          else if (adjustedCellVoltage >= 3.39) return 10 + ((adjustedCellVoltage - 3.39) / (3.48 - 3.39)) * 10;
          else if (adjustedCellVoltage >= 3.0) return 0 + ((adjustedCellVoltage - 3.0) / (3.39 - 3.0)) * 10;
          else return 0;
      }
    }
  
    // Helper function to safely send control commands (supports both Cerbo GX and MultiPlus II GX)
    function setGridState(enabled, reason) {
      try {
        const config = getConfig();
        
        // Safety check - disable control if configuration is invalid
        if (!config || !config.chemistry || !config.cellCount) {
          log('error', 'Invalid battery configuration - DISABLING CONTROL for safety');
          return;
        }
        
        // Method 1: Try MultiPlus II GX direct AC input control (preferred for built-in GX)
        if (config.controlMethod === 'multiplus-gx' || config.controlMethod === 'auto') {
          // Primary control: ignoreAcIn1 state (0=enabled, 1=ignored/disabled)
          app.handleMessage('smart-grid-controller', {
            updates: [{
              values: [{
                path: 'electrical.inverters.275.acState.ignoreAcIn1.state',
                value: enabled ? 0 : 1  // 0=don't ignore AC input, 1=ignore AC input
              }]
            }]
          });
          
          log('info', `MultiPlus II GX AC input ${enabled ? 'ENABLED' : 'DISABLED'} - ${reason}`);
        }
        
        // Method 2: Fallback to Cerbo GX relay control (for external GX units)
        if (config.controlMethod === 'cerbo-gx' || config.controlMethod === 'auto') {
          app.handleMessage('smart-grid-controller', {
            updates: [{
              values: [{
                path: 'electrical.switches.relay1.state',
                value: enabled ? 1 : 0
              }]
            }]
          });
          
          if (config.controlMethod === 'cerbo-gx') {
            log('info', `Cerbo GX Relay 1 ${enabled ? 'ENABLED' : 'DISABLED'} - ${reason}`);
          }
        }
        
      } catch (error) {
        log('error', `Error setting grid state to ${enabled} (${reason}) - ${error.message}`);
      }
    }
  
    return {
      id: 'smart-grid-controller',
      name: 'Smart Grid Controller',
      description: 'Intelligent AC grid management for Victron MultiPlus II with load-based switching, battery protection, and scheduled charging',
  
      start: function() {
        // Enable grid immediately on startup
        log('info', 'Grid AC ENABLED on startup - 30s grace period active');
        setGridState(true, 'Startup - 30s grace period active');
        
        // Log battery configuration for user verification
        const config = getConfig();
        if (!config) {
          log('error', '***************************************************');
          log('error', '* CRITICAL: Battery Ah rating not configured!    *');
          log('error', '* Plugin DISABLED for safety.                    *');
          log('error', '* Configure Battery Capacity in plugin settings. *');
          log('error', '***************************************************');
          return; // Exit plugin startup
        }
        
        if (config) {
          log('info', `Battery Configuration: ${config.chemistry.toUpperCase()} ${config.cellCount}S | Capacity: ${config.batteryCapacityKwh.toFixed(1)}kWh | Charge/Discharge Threshold: ±${config.onePercentThresholdW.toFixed(0)}W (1%)`);
        }
        
        // Start 30-second startup grace period
        startupGraceTimer = setTimeout(() => {
          startupGraceTimer = null;
          log('info', 'Startup grace period ended - normal condition evaluation active');
        }, 30000);
  
        // Subscribe to Victron data
        app.signalk.on('delta', (delta) => {
          try {
            const voltage = app.getSelfPath('electrical.chargers.275.voltage')?.value || 0;
            const load = app.getSelfPath('electrical.inverters.275.acout.power')?.value || 0;
            const chargePower = app.getSelfPath('electrical.chargers.275.power')?.value || 0;
            
            // Validate data - skip processing if values are clearly invalid
            if (voltage < 0 || voltage > 100 || load < 0 || load > 50000) {
              log('warn', `Invalid data - Voltage: ${voltage}V, Load: ${load}W - skipping cycle`);
              return;
            }
            
            const config = getConfig();
            
            // Safety check - disable control if configuration is invalid
            if (!config || !config.chemistry || !config.cellCount) {
              log('error', 'Invalid battery configuration - DISABLING CONTROL for safety');
              return;
            }

            // Get time in configured timezone with error handling
            let localTime, hours, isChargingWindow;

            // Figure out if we are in the charging window
            try {
              const now = new Date();
              localTime = new Date(now.toLocaleString("en-US", {timeZone: config.scheduleSettings.timezone}));
              hours = localTime.getHours();
              isChargingWindow = (hours >= config.scheduleSettings.startHour && hours < config.scheduleSettings.endHour);

            // If we can't get the time, use local time
            } catch (timezoneError) {
              log('warn', `Invalid timezone ${config.scheduleSettings.timezone}, falling back to local time`);
              localTime = new Date();
              hours = localTime.getHours();
              isChargingWindow = (hours >= config.scheduleSettings.startHour && hours < config.scheduleSettings.endHour);
            }

            // Calculate SoC from voltage based on battery type, cell count, and charging state
            let soc = calculateSoC(voltage, config.chemistry, config.cellCount, chargePower, config.onePercentThresholdW);
            
            // Ensure SoC is within valid range
            soc = Math.max(0, Math.min(100, soc));

            // Condition 1: Load > threshold for 3 seconds (enable) / < threshold (disable immediately)
            if (load > config.loadThresholds.enableWatts && !enabledByLoad) {
              if (!loadEnableTimer) {
                loadEnableTimer = setTimeout(() => {
                  enabledByLoad = true;
                  loadEnableTimer = null;
                }, 3000);
              }
            } else if (load < config.loadThresholds.disableWatts) {
              enabledByLoad = false;
              clearTimeout(loadEnableTimer);
              loadEnableTimer = null;
            } else if (load >= config.loadThresholds.disableWatts && load <= config.loadThresholds.enableWatts && loadEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(loadEnableTimer);
              loadEnableTimer = null;
            }
  
            // Condition 2: Voltage < threshold for 3 seconds (enable) / > threshold (disable immediately)
            if (voltage < config.voltageThresholds.lowVoltageEnable && !enabledByVoltage) {
              if (!voltageEnableTimer) {
                voltageEnableTimer = setTimeout(() => {
                  enabledByVoltage = true;
                  voltageEnableTimer = null;
                }, 3000);
              }
            } else if (voltage > config.voltageThresholds.lowVoltageDisable) {
              enabledByVoltage = false;
              clearTimeout(voltageEnableTimer);
              voltageEnableTimer = null;
            } else if (voltage >= config.voltageThresholds.lowVoltageEnable && voltage <= config.voltageThresholds.lowVoltageDisable && voltageEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(voltageEnableTimer);
              voltageEnableTimer = null;
            }
  
            // Condition 3: SoC < threshold for 3 seconds (enable) / > threshold (disable immediately)
            if (soc < config.socThresholds.lowSocEnable && !enabledBySoC) {
              if (!socEnableTimer) {
                socEnableTimer = setTimeout(() => {
                  enabledBySoC = true;
                  socEnableTimer = null;
                }, 3000);
              }
            } else if (soc > config.socThresholds.lowSocDisable) {
              enabledBySoC = false;
              clearTimeout(socEnableTimer);
              socEnableTimer = null;
            } else if (soc >= config.socThresholds.lowSocEnable && soc <= config.socThresholds.lowSocDisable && socEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(socEnableTimer);
              socEnableTimer = null;
            }
  
            // Condition 4: Scheduled charging window (immediate enable/disable)
            enabledByTime = isChargingWindow;
  
            // Battery protection with hysteresis: configurable thresholds
            const highVoltageRecovery = config.voltageThresholds.highVoltageProtection - 0.75; // 0.75V hysteresis
            const highSocRecovery = config.socThresholds.highSocProtection - 2.5; // 2.5% hysteresis
            
            // If voltage or SoC is above threshold and battery protection is not active, activate battery protection
            if ((voltage >= config.voltageThresholds.highVoltageProtection || soc >= config.socThresholds.highSocProtection) && !batteryProtectionActive) {
              batteryProtectionActive = true;
              log('info', `Battery protection ACTIVATED - Voltage: ${voltage.toFixed(2)}V (>= ${config.voltageThresholds.highVoltageProtection}V), SoC: ${soc.toFixed(1)}% (>= ${config.socThresholds.highSocProtection}%)`);
            
            // If voltage and SoC are below threshold and battery protection is active, deactivate battery protection
            } else if (voltage < highVoltageRecovery && soc < highSocRecovery && batteryProtectionActive) {
              batteryProtectionActive = false;
              log('info', `Battery protection CLEARED - Voltage: ${voltage.toFixed(2)}V (< ${highVoltageRecovery}V), SoC: ${soc.toFixed(1)}% (< ${highSocRecovery}%)`);
            }
            
            // If voltage is above threshold and emergency protection is not active, activate emergency protection
            const emergencyRecovery = config.voltageThresholds.emergencyVoltage - 0.75; // 0.75V hysteresis
            if (voltage >= config.voltageThresholds.emergencyVoltage && !emergencyProtectionActive) {
              emergencyProtectionActive = true;
              log('info', `Emergency protection ACTIVATED - Voltage: ${voltage.toFixed(2)}V >= ${config.voltageThresholds.emergencyVoltage}V`);
            
            // If voltage is below threshold and emergency protection is active, deactivate emergency protection
            } else if (voltage < emergencyRecovery && emergencyProtectionActive) {
              emergencyProtectionActive = false;
              log('info', `Emergency protection CLEARED - Voltage: ${voltage.toFixed(2)}V < ${emergencyRecovery}V`);
            }

            // Determine if any condition is active
            const anyConditionActive = enabledByLoad || enabledByVoltage || enabledBySoC || enabledByTime;
            
            // Emergency protection overrides everything (including load condition)
            const emergencyProtectionTriggered = emergencyProtectionActive;

            // Handle grid control logic
            if (emergencyProtectionTriggered && gridState) {
              // Emergency protection triggered - disable grid immediately, no exceptions
              clearTimeout(disableTimer);
              disableTimer = null;
              gridState = false;
              
              log('info', `Emergency protection triggered - Critical voltage ${voltage.toFixed(2)}V >= ${config.voltageThresholds.emergencyVoltage}V`);
              
              setGridState(false, 'Emergency protection triggered');
            } else if (batteryProtectionActive && gridState) {
              // Battery protection triggered - disable grid immediately (only load condition can override, not time)
              const canOverrideProtection = enabledByLoad; // Only high load can override battery protection
              
              if (!canOverrideProtection) {
                clearTimeout(disableTimer);
                disableTimer = null;
                gridState = false;
                
                const protectionReasons = [];
                if (voltage >= config.voltageThresholds.highVoltageProtection) protectionReasons.push(`High voltage: ${voltage.toFixed(2)}V >= ${config.voltageThresholds.highVoltageProtection}V`);
                if (soc >= config.socThresholds.highSocProtection) protectionReasons.push(`High SoC: ${soc.toFixed(1)}% >= ${config.socThresholds.highSocProtection}%`);
                
                const overrideStatus = enabledByTime ? ' (Time condition ignored for safety)' : '';
                log('info', `Battery protection: ${protectionReasons.join(', ')} (Load override: ${enabledByLoad ? 'Active' : 'Inactive'})${overrideStatus}`);
                
                setGridState(false, `Battery protection: ${protectionReasons.join(', ')}${overrideStatus}`);
              }
            } else if (anyConditionActive && !gridState && !batteryProtectionActive && !emergencyProtectionActive) {
              // Conditions want to enable grid and no protection active - turn on immediately
              clearTimeout(disableTimer);
              disableTimer = null;
              gridState = true;
              
              // Log which conditions are active
              const activeConditions = [];
              if (enabledByLoad) activeConditions.push(`Load: ${load.toFixed(1)}W`);
              if (enabledByVoltage) activeConditions.push(`Voltage: ${voltage.toFixed(2)}V`);
              if (enabledBySoC) activeConditions.push(`SoC: ${soc.toFixed(1)}%`);
              if (enabledByTime) activeConditions.push(`Time: ${hours.toString().padStart(2, '0')}:${localTime.getMinutes().toString().padStart(2, '0')}`);
              
              log('info', `Active conditions: ${activeConditions.join(', ')}`);
              
              setGridState(true, `Active conditions: ${activeConditions.join(', ')}`);
            } else if (!anyConditionActive && gridState && !startupGraceTimer) {
              // No conditions want grid enabled and startup grace period is over - start 30 second disable timer
              if (!disableTimer) {
                disableTimer = setTimeout(() => {
                  gridState = false;
                  disableTimer = null;
                  
                  // Log which conditions were cleared
                  const clearedConditions = [];
                  if (!enabledByLoad) clearedConditions.push(`Load: ${load.toFixed(1)}W < ${config.loadThresholds.disableWatts}W`);
                  if (!enabledByVoltage) clearedConditions.push(`Voltage: ${voltage.toFixed(2)}V > ${config.voltageThresholds.lowVoltageDisable}V`);
                  if (!enabledBySoC) clearedConditions.push(`SoC: ${soc.toFixed(1)}% > ${config.socThresholds.lowSocDisable}%`);
                  if (!enabledByTime) clearedConditions.push(`Time: ${hours.toString().padStart(2, '0')}:${localTime.getMinutes().toString().padStart(2, '0')} outside ${config.scheduleSettings.startHour.toString().padStart(2, '0')}:00-${config.scheduleSettings.endHour.toString().padStart(2, '0')}:00`);
                  
                  log('info', `Cleared conditions: ${clearedConditions.join(', ')}`);
                  
                  setGridState(false, `Cleared conditions: ${clearedConditions.join(', ')}`);
                }, 30000);
              }
            } else if (anyConditionActive && gridState && !batteryProtectionActive && !emergencyProtectionActive) {
              // Conditions still want grid enabled and no protection active - clear any pending disable timer
              clearTimeout(disableTimer);
              disableTimer = null;
            }

            // Log system state for debugging
            logSystemState(voltage, soc, load, config, chargePower);
          } catch (error) {
            log('error', `Error processing data - ${error.message}`);
          }
        });
  
        // Map Signal K control to both MultiPlus II GX and Cerbo GX Relay
        app.registerPutHandler('v1', 'electrical.switches.relay1.state', (context, path, value) => {
          try {
            app.putSelfPath('electrical.switches.relay1.state', value);
            if (app.dbus && app.dbus.setValue) {
              app.dbus.setValue('com.victronenergy.system', '/Relay/1/State', value);
            } else {
              log('warn', 'D-Bus not available - relay state not updated on Cerbo GX');
            }
          } catch (error) {
            log('error', `Error setting relay state - ${error.message}`);
          }
        });
        
        // MultiPlus II GX AC input control handlers
        app.registerPutHandler('v1', 'electrical.inverters.275.acState.ignoreAcIn1.state', (context, path, value) => {
          try {
            app.putSelfPath('electrical.inverters.275.acState.ignoreAcIn1.state', value);
            if (app.dbus && app.dbus.setValue) {
              // MultiPlus II GX ignore AC input control (0=enabled, 1=disabled)
              app.dbus.setValue('com.victronenergy.vebus.ttyS3', '/Ac/State/IgnoreAcIn1', value);
            }
          } catch (error) {
            log('error', `Error setting AC input ignore state - ${error.message}`);
          }
        });
      },
  
      stop: function() {
        clearTimeout(loadEnableTimer);
        clearTimeout(voltageEnableTimer);
        clearTimeout(socEnableTimer);
        clearTimeout(disableTimer);
        clearTimeout(startupGraceTimer);
        clearTimeout(debugTimer);
      }
    };
  };