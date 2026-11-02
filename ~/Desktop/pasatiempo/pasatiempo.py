import random
import string


def crear_sopa_letras(tamano=10, num_palabras=5):
    """Crea una sopa de letras de tamano x tamano con num_palabras palabras."""
    # Lista de palabras para el pasatiempo
    palabras_disponibles = [
        "PYTHON", "CODIGO", "JUEGO", "LETRA", "SOLUCION",
        "PROGRAMA", "COMPUTADORA", "TECLADO", "PANTALLA", "RATON",
        "ALGORITMO", "VARIABLE", "FUNCION", "BUCLE", "CONDICION",
        "DATOS", "ARCHIVO", "MEMORIA", "PROCESADOR", "SISTEMA"
    ]

    # Seleccionar palabras aleatorias
    palabras = random.sample(palabras_disponibles, min(num_palabras, len(palabras_disponibles)))

    # Inicializar cuadrícula vacía
    grid = [[None for _ in range(tamano)] for _ in range(tamano)]

    # Direcciones posibles: (dx, dy, nombre_direccion)
    direcciones = [
        (0, 1, "horizontal →"),
        (0, -1, "horizontal ←"),
        (1, 0, "vertical ↓"),
        (-1, 0, "vertical ↑"),
        (1, 1, "diagonal ↘"),
        (1, -1, "diagonal ↙"),
        (-1, 1, "diagonal ↗"),
        (-1, -1, "diagonal ↖")
    ]

    palabras_colocadas = []

    for palabra in palabras:
        colocada = False
        intentos = 0
        max_intentos = 100

        while not colocada and intentos < max_intentos:
            dir_idx = random.randint(0, len(direcciones) - 1)
            dx, dy, dir_nombre = direcciones[dir_idx]

            # Calcular rango válido para posición inicial
            if dx == 1:
                max_fila = tamano - len(palabra)
            elif dx == -1:
                max_fila = tamano - 1
                min_fila = len(palabra) - 1
            else:
                max_fila = tamano - 1
                min_fila = 0

            if dy == 1:
                max_col = tamano - len(palabra)
            elif dy == -1:
                max_col = tamano - 1
                min_col = len(palabra) - 1
            else:
                max_col = tamano - 1
                min_col = 0

            if dx == 1:
                fila = random.randint(0, max_fila)
            elif dx == -1:
                fila = random.randint(len(palabra) - 1, tamano - 1)
            else:
                fila = random.randint(0, tamano - 1)

            if dy == 1:
                col = random.randint(0, max_col)
            elif dy == -1:
                col = random.randint(len(palabra) - 1, tamano - 1)
            else:
                col = random.randint(0, tamano - 1)

            # Verificar si la palabra cabe
            puede_colocar = True
            for i, letra in enumerate(palabra):
                nf, nc = fila + i * dx, col + i * dy
                if grid[nf][nc] is not None and grid[nf][nc] != letra:
                    puede_colocar = False
                    break

            if puede_colocar:
                for i, letra in enumerate(palabra):
                    nf, nc = fila + i * dx, col + i * dy
                    grid[nf][nc] = letra
                palabras_colocadas.append((palabra, fila, col, dir_nombre))
                colocada = True

            intentos += 1

        if not colocada:
            print(f"Advertencia: No se pudo colocar la palabra '{palabra}'")

    # Rellenar espacios vacíos con letras aleatorias
    for i in range(tamano):
        for j in range(tamano):
            if grid[i][j] is None:
                grid[i][j] = random.choice(string.ascii_uppercase)

    return grid, palabras_colocadas


def mostrar_sopa(grid, palabras_colocadas):
    """Muestra la sopa de letras por consola."""
    tamano = len(grid)

    print("=" * 50)
    print("         SOPA DE LETRAS 10x10")
    print("=" * 50)
    print()

    # Encabezado de columnas
    print("    " + "  ".join(str(i) for i in range(tamano)))
    print("   " + "--" * tamano)

    # Filas con números
    for i, fila in enumerate(grid):
        print(f"{i:2} |" + "  ".join(fila) + "  |")

    print("   " + "--" * tamano)
    print()

    # Mostrar palabras a buscar
    print("PALABRAS A BUSCAR:")
    print("-" * 30)
    for palabra, fila, col, direccion in palabras_colocadas:
        print(f"  • {palabra} (fila {fila}, col {col}, {direccion})")

    print()
    print("PALABRAS (sin pistas):")
    print("-" * 30)
    for palabra, _, _, _ in palabras_colocadas:
        print(f"  • {palabra}")
    print()
    print("¡Diviértete buscando!\n")


def main():
    random.seed()  # Usar semilla aleatoria basada en tiempo
    grid, palabras_colocadas = crear_sopa_letras(10, 5)
    mostrar_sopa(grid, palabras_colocadas)


if __name__ == "__main__":
    main()
