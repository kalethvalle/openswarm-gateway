# ADR-0001: motor multimodelo con responsable y consultas

Estado: aceptado. Especificaciones: SPEC-002, SPEC-003, SPEC-004, SPEC-005, SPEC-006.

La API pública permanece estable. El motor v2 usa decisiones Laya y respaldo generativo, consultas internas secuenciales, contexto con referencias y un registro multiproveedor. Los estados sin engineVersion se ejecutan con el motor histórico.

Los borradores de colaboración se almacenan antes de publicarse. El retorno al responsable evita una síntesis adicional fija. No se cambia de modelo tras publicar texto; después de herramientas solo se cambia con la ronda completa y contexto portable.

La gratuidad de Groq depende de la cuenta Free declarada por el operador; OpenRouter exige candidatos explícitos :free y catálogo de precio cero. La cuota local no coordina aplicaciones externas: las cabeceras y los 429 prevalecen.

La configuración personal y los datos privados no se versionan. SDD usa Markdown y Git para no añadir infraestructura obligatoria.
