import pandas as pd

df = pd.read_excel(r'data/Clientes de arranque y pareto.xlsx', sheet_name='CLIENTES VENTA (2)', header=None, skiprows=25)
df.columns = ['Gerencia','Agente','Supervisor','CuentaMostrador','Padre','Cadena','NombreFarmacia','Municipio','Estado','Cam','Pareto']
df = df[df['Gerencia'].notna() & ~df['Gerencia'].isin(['Gerencia'])]

ecat = df[df['Municipio'].str.contains('ECATEPEC', na=False)].copy()
print('=== FARMACIAS MARZAM EN ECATEPEC ===')
print('Total:', len(ecat))

print('\n=== MUESTRA DE NOMBRES (primeros 60) ===')
for _, r in ecat[['CuentaMostrador','Cadena','NombreFarmacia','Pareto']].head(60).iterrows():
    cadena = r['Cadena'] if pd.notna(r['Cadena']) else '-'
    pareto = r['Pareto'] if pd.notna(r['Pareto']) else '?'
    nombre = r['NombreFarmacia'] if pd.notna(r['NombreFarmacia']) else '???'
    print(f'  [{pareto}] {nombre}  |  cadena: {cadena}')

print('\n=== CADENAS MARZAM EN ECATEPEC ===')
cadenas = ecat[ecat['Cadena'].notna()]['Cadena'].value_counts()
print(cadenas.to_string())

print('\n=== INDEPENDIENTES (sin cadena) ===')
indep = ecat[ecat['Cadena'].isna()]
print(f'Total independientes: {len(indep)}')
print('Muestra de nombres:')
for _, r in indep[['NombreFarmacia']].head(30).iterrows():
    nombre = r['NombreFarmacia'] if pd.notna(r['NombreFarmacia']) else '???'
    print(f'  {nombre}')

print('\n=== PATRONES EN NOMBRES MARZAM ===')
nombres = ecat['NombreFarmacia'].dropna().str.upper()
print(f'Empiezan con FARMACIA: {nombres.str.startswith("FARMACIA").sum()}')
print(f'Empiezan con FARM*: {nombres.str.startswith("FARM").sum()}')
print(f'Contienen SUC (sucursal): {nombres.str.contains("SUC").sum()}')
print(f'Contienen SA DE CV o similar: {nombres.str.contains("SA DE CV|S.A.|S DE RL", regex=True).sum()}')

print('\n=== TODOS LOS NOMBRES UNICOS MARZAM ECATEPEC ===')
for n in sorted(ecat['NombreFarmacia'].dropna().unique()):
    print(f'  {n}')
