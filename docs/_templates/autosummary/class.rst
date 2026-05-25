{{ fullname | escape | underline}}

.. currentmodule:: {{ module }}

.. autoclass:: {{ objname }}

   {% set grammar = grammar_by_class.get(objname, {}) %}
   {% if grammar %}
   {% block grammar %}
   .. rubric:: Lark grammar

   This class is used by the following grammar rules:

   {% for name, source in grammar.items() %}
   ``{{ name }}``

   .. code::

     {{ source | indent("     ") }}

   {% endfor %}
   {% endblock %}
   {% endif %}

   {% block methods %}
   {% if methods %}
   .. rubric:: {{ _('Methods') }}

   .. autosummary::

   {% for item in methods %}
   {%- if item not in inherited_members %}
       ~{{ name }}.{{ item }}
   {%- endif %}
   {%- endfor %}
   {% endif %}
   {% endblock %}

   {% block attributes %}
   {% if attributes %}
   .. rubric:: {{ _('Attributes') }}

   {% for item in attributes %}
   {%- if item not in inherited_members and item != "type" %}
   - :py:attr:`~{{ fullname }}.{{ item }}`
   {%- endif %}
   {%- endfor %}

   {%- endif %}
   {% endblock %}
